import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePromptModelCue } from "./prompt-model-selection.js";

function buildConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-5.4",
          fallbacks: ["openai/gpt-5.4-mini"],
        },
        models: {
          "openai/gpt-5.4": { alias: "smart" },
          "openai/gpt-5.4-mini": { alias: "cheap" },
        },
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [
            {
              id: "gpt-5.4",
              name: "GPT-5.4",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 10, output: 30, cacheRead: 1, cacheWrite: 1 },
              contextWindow: 200000,
              maxTokens: 64000,
            },
            {
              id: "gpt-5.4-mini",
              name: "GPT-5.4 Mini",
              reasoning: false,
              input: ["text"],
              cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.1 },
              contextWindow: 128000,
              maxTokens: 32000,
            },
          ],
        },
      },
    },
  } as OpenClawConfig;
}

describe("resolvePromptModelCue", () => {
  it("leaves prompts unchanged when they do not start with a cue", () => {
    expect(
      resolvePromptModelCue({
        cfg: buildConfig(),
        prompt: "hello @cheap",
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      kind: "none",
      prompt: "hello @cheap",
    });
  });

  it("resolves explicit alias cues and strips them from the prompt", () => {
    expect(
      resolvePromptModelCue({
        cfg: buildConfig(),
        prompt: "@cheap summarize this",
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      kind: "explicit",
      rawCue: "@cheap",
      key: "openai/gpt-5.4-mini",
      ref: { provider: "openai", model: "gpt-5.4-mini" },
      alias: "cheap",
      prompt: "summarize this",
    });
  });

  it("resolves explicit provider/model cues", () => {
    expect(
      resolvePromptModelCue({
        cfg: buildConfig(),
        prompt: "@openai/gpt-5.4 explain the failure",
        defaultProvider: "openai",
        defaultModel: "gpt-5.4-mini",
      }),
    ).toEqual({
      kind: "explicit",
      rawCue: "@openai/gpt-5.4",
      key: "openai/gpt-5.4",
      ref: { provider: "openai", model: "gpt-5.4" },
      alias: undefined,
      prompt: "explain the failure",
    });
  });

  it("routes simple @auto prompts to the cheapest configured model", () => {
    expect(
      resolvePromptModelCue({
        cfg: buildConfig(),
        prompt: "@auto summarize this error",
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toMatchObject({
      kind: "auto",
      rawCue: "@auto",
      key: "openai/gpt-5.4-mini",
      ref: { provider: "openai", model: "gpt-5.4-mini" },
      complexity: "simple",
      prompt: "summarize this error",
    });
  });

  it("keeps complex @auto prompts on the default model", () => {
    const prompt = [
      "@auto debug this regression in src/agents/pi-embedded-runner/run.ts",
      "```ts",
      "export async function brokenThing() {",
      "  throw new Error('boom');",
      "}",
      "```",
      "Traceback: Error: prompt failed",
    ].join("\n");

    expect(
      resolvePromptModelCue({
        cfg: buildConfig(),
        prompt,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toMatchObject({
      kind: "auto",
      key: "openai/gpt-5.4",
      ref: { provider: "openai", model: "gpt-5.4" },
      complexity: "complex",
    });
  });

  it("keeps image prompts on the image-capable default when the cheapest model cannot accept images", () => {
    expect(
      resolvePromptModelCue({
        cfg: buildConfig(),
        prompt: "@auto describe this screenshot",
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        requiresImage: true,
      }),
    ).toMatchObject({
      kind: "auto",
      key: "openai/gpt-5.4",
      ref: { provider: "openai", model: "gpt-5.4" },
    });
  });

  it("preserves unresolved leading mentions instead of stripping them", () => {
    expect(
      resolvePromptModelCue({
        cfg: buildConfig(),
        prompt: "@darby please review this",
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      kind: "none",
      prompt: "@darby please review this",
    });
  });
});
