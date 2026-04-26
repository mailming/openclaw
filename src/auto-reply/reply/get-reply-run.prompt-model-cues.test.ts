import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { applyPromptCueOverrideForAutoReply } from "./get-reply-run.js";

function buildCueConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "purdue-studio/gpt-oss:120b",
        },
        models: {
          "purdue-studio/gpt-oss:120b": {
            alias: "purdue-fallback",
          },
          "purdue-studio/deepseek-r1:1.5b": {
            alias: "purdue-free",
          },
        },
      },
    },
    models: {
      providers: {
        "purdue-studio": {
          models: [
            {
              id: "gpt-oss:120b",
              cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              input: ["text", "image"],
              reasoning: true,
              contextWindow: 128000,
            },
            {
              id: "deepseek-r1:1.5b",
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              input: ["text", "image"],
              reasoning: true,
              contextWindow: 128000,
            },
          ],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("applyPromptCueOverrideForAutoReply", () => {
  it("honors explicit prompt cues even when session hints precede the rendered prompt", () => {
    const result = applyPromptCueOverrideForAutoReply({
      cfg: buildCueConfig(),
      agentId: "main",
      promptSource: "@purdue-free hello",
      prefixedCommandBody:
        "[System event]\nResumed after /start.\n\n[User]\n@purdue-free hello",
      provider: "purdue-studio",
      model: "gpt-oss:120b",
      requiresImage: false,
    });

    expect(result.provider).toBe("purdue-studio");
    expect(result.model).toBe("deepseek-r1:1.5b");
    expect(result.prefixedCommandBody).toContain("[System event]");
    expect(result.prefixedCommandBody).toContain("[User]\nhello");
    expect(result.prefixedCommandBody).not.toContain("@purdue-free hello");
  });

  it("leaves non-cue prompts unchanged", () => {
    const body = "[System event]\n\nhello";
    const result = applyPromptCueOverrideForAutoReply({
      cfg: buildCueConfig(),
      agentId: "main",
      promptSource: "hello",
      prefixedCommandBody: body,
      provider: "purdue-studio",
      model: "gpt-oss:120b",
      requiresImage: false,
    });

    expect(result.provider).toBe("purdue-studio");
    expect(result.model).toBe("gpt-oss:120b");
    expect(result.prefixedCommandBody).toBe(body);
  });
});
