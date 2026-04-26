import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

function buildPromptCueConfig(): OpenClawConfig {
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
          "openai/gpt-5.4-nano": { alias: "chatonly" },
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
            {
              id: "gpt-5.4-nano",
              name: "GPT-5.4 Nano",
              reasoning: false,
              compat: { supportsTools: false },
              input: ["text"],
              cost: { input: 5, output: 5, cacheRead: 0.1, cacheWrite: 0.1 },
              contextWindow: 64000,
              maxTokens: 16000,
            },
          ],
        },
      },
    },
  } as OpenClawConfig;
}

describe("runEmbeddedPiAgent prompt model cues", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ promptError: null }));
  });

  it("strips explicit model cues from hook and attempt prompts", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation((hookName) => hookName === "before_model_resolve");
    mockedGlobalHookRunner.runBeforeModelResolve.mockResolvedValueOnce({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
    });

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      config: buildPromptCueConfig(),
      prompt: "@cheap summarize this thread",
      runId: "run-prompt-explicit-cue",
    });

    expect(mockedGlobalHookRunner.runBeforeModelResolve).toHaveBeenCalledWith(
      { prompt: "summarize this thread" },
      expect.anything(),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "summarize this thread",
        provider: "openai",
        modelId: "gpt-5.4-mini",
      }),
    );
  });

  it("routes simple @auto prompts to the cheaper configured model", async () => {
    const onModelSelected = vi.fn();

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      config: buildPromptCueConfig(),
      prompt: "@auto summarize this thread",
      onModelSelected,
      runId: "run-prompt-auto-cue",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "summarize this thread",
        provider: "openai",
        modelId: "gpt-5.4-mini",
      }),
    );
    expect(onModelSelected).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-5.4-mini",
      thinkLevel: "off",
    });
  });

  it("keeps complex @auto prompts on the default model", async () => {
    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      config: buildPromptCueConfig(),
      prompt: [
        "@auto debug this regression in src/agents/pi-embedded-runner/run.ts",
        "```ts",
        "throw new Error('boom')",
        "```",
        "Traceback: Error: prompt failed",
      ].join("\n"),
      runId: "run-prompt-auto-complex-cue",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.4",
      }),
    );
  });

  it("retries empty successful turns with tools disabled", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          lastAssistant: {
            role: "assistant",
            content: [],
            stopReason: "stop",
          } as unknown as NonNullable<ReturnType<typeof makeAttemptResult>["lastAssistant"]>,
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Hello!"],
          lastAssistant: {
            role: "assistant",
            content: [{ type: "text", text: "Hello!" }],
            stopReason: "stop",
          } as unknown as NonNullable<ReturnType<typeof makeAttemptResult>["lastAssistant"]>,
        }),
      );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      config: buildPromptCueConfig(),
      prompt: "@auto hello",
      runId: "run-empty-success-retry",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        disableTools: false,
        recoverSilentResponseHistory: false,
      }),
    );
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        disableTools: true,
        recoverSilentResponseHistory: true,
      }),
    );
    expect(result.meta).toEqual(
      expect.objectContaining({
        aborted: false,
      }),
    );
  });
});
