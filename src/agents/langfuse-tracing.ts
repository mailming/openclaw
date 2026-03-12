/**
 * Optional Langfuse integration for OpenClaw agent LLM calls.
 *
 * When LANGFUSE_SECRET_KEY (and optionally LANGFUSE_PUBLIC_KEY, LANGFUSE_BASE_URL)
 * are set and @langfuse/tracing (and optionally @langfuse/otel, @opentelemetry/sdk-node)
 * are installed, this module wraps the agent streamFn so each LLM call is reported
 * to Langfuse as a generation (input, output, model, usage).
 *
 * If the packages are not installed or env is not set, createLangfuseStreamFnWrapper
 * returns null and no instrumentation is applied.
 */

import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

export type LangfuseStreamFnWrapperParams = {
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
};

export type LangfuseStreamFnWrapper = {
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
};

let otelSdkStarted = false;

async function ensureOtelStarted(): Promise<boolean> {
  if (otelSdkStarted) {
    return true;
  }
  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { LangfuseSpanProcessor } = await import("@langfuse/otel");
    // Cast: pnpm can hoist two @opentelemetry/sdk-trace-base versions; LangfuseSpanProcessor is compatible at runtime.
    const sdk = new NodeSDK({
      spanProcessors: [new LangfuseSpanProcessor()],
    } as unknown as ConstructorParameters<typeof NodeSDK>[0]);
    sdk.start();
    otelSdkStarted = true;
    return true;
  } catch {
    return false;
  }
}

function extractUsageFromAssistantMessage(message: unknown): Record<string, number> | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const m = message as { usage?: { input?: number; output?: number; totalTokens?: number } };
  const u = m.usage;
  if (!u) {
    return undefined;
  }
  const input = u.input ?? 0;
  const output = u.output ?? 0;
  const total = u.totalTokens ?? input + output;
  if (input === 0 && output === 0 && total === 0) {
    return undefined;
  }
  return { input, output, total };
}

function safeSerializeOutput(value: unknown): unknown {
  try {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === "object" && "role" in value && "content" in value) {
      const msg = value as { role: string; content: unknown; usage?: unknown };
      return {
        role: msg.role,
        content: msg.content,
        ...(msg.usage !== undefined && msg.usage !== null ? { usage: msg.usage } : {}),
      };
    }
    return value;
  } catch {
    return String(value);
  }
}

/**
 * Deep-sanitize a value so the Langfuse SDK never sees `undefined` anywhere
 * in the object tree. Replaces undefined → null, removes undefined array slots.
 */
function deepSanitize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map(deepSanitize);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepSanitize(v);
  }
  return out;
}

/** Sanitize messages for Langfuse input so the SDK never sees undefined .name or other fragile shapes. */
function safeSerializeMessages(messages: unknown[]): unknown[] {
  return messages.map((msg) => {
    if (msg === null || msg === undefined) {
      return { role: "unknown", content: "" };
    }
    if (typeof msg !== "object") {
      return { role: "unknown", content: String(msg) };
    }
    const m = msg as Record<string, unknown>;
    const role = typeof m.role === "string" ? m.role : "unknown";
    // Deep-sanitize content so tool_use/tool_result blocks with undefined fields don't crash the SDK
    const content = deepSanitize(m.content);
    const out: Record<string, unknown> = { role, content };
    if (m.usage !== undefined && m.usage !== null && typeof m.usage === "object") {
      out.usage = deepSanitize(m.usage);
    }
    return out;
  });
}

/**
 * Returns a Langfuse streamFn wrapper when LANGFUSE_SECRET_KEY is set and
 * @langfuse/tracing (and optional OpenTelemetry packages) are available.
 * Otherwise returns null.
 */
export async function createLangfuseStreamFnWrapper(
  params: LangfuseStreamFnWrapperParams,
): Promise<LangfuseStreamFnWrapper | null> {
  const env = params.env ?? process.env;
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  if (!secretKey) {
    return null;
  }
  try {
    const { startObservation } = await import("@langfuse/tracing");
    await ensureOtelStarted();
  } catch {
    return null;
  }

  const { startObservation } = await import("@langfuse/tracing");
  const meta = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    modelId: params.modelId,
  };

  const wrapStreamFn: LangfuseStreamFnWrapper["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      const rawMessages = (context as { messages?: AgentMessage[] }).messages ?? [];
      const messages = safeSerializeMessages(rawMessages);
      const modelId =
        (model as Model<Api> | undefined)?.id ?? params.modelId ?? "unknown";
      const provider =
        (model as Model<Api> | undefined)?.provider ?? params.provider ?? "unknown";

      let observation: ReturnType<typeof startObservation> | null = null;
      try {
        // Sanitize all payloads so the SDK never sees undefined (e.g. .name on undefined).
        const inputPayload = deepSanitize({ input: messages, model: modelId });
        const optsPayload = deepSanitize({
          asType: "generation",
          metadata: { ...meta, provider },
        });
        observation = startObservation(
          "openclaw-llm",
          inputPayload as { input: unknown; model: string },
          optsPayload as { asType: "generation"; metadata: Record<string, unknown> },
        );
      } catch (err) {
        // Langfuse SDK can throw on unexpected input (e.g. undefined .name); don't break the agent.
        return streamFn(model, context, options);
      }

      const run = (stream: ReturnType<StreamFn>) => {
        if (!observation) {
          return stream;
        }
        if (!stream || typeof stream !== "object") {
          try {
            observation.update({ output: null });
            observation.end();
          } catch {
            /* ignore */
          }
          return stream;
        }
        const streamWithResult = stream as { result?: () => Promise<unknown> };
        const originalResult = streamWithResult.result?.bind(stream);
        if (typeof originalResult !== "function") {
          try {
            observation.end();
          } catch {
            /* ignore */
          }
          return stream;
        }
        const wrappedResult = async () => {
          try {
            const result = await originalResult();
            if (observation) {
              try {
                const usage = extractUsageFromAssistantMessage(result);
                const output = deepSanitize(safeSerializeOutput(result));
                observation.update({
                  output,
                  ...(usage ? { usage } : {}),
                });
              } catch {
                /* ignore */
              }
            }
            return result;
          } catch (err) {
            if (observation) {
              try {
                observation.update({ output: undefined, level: "ERROR" });
              } catch {
                /* ignore */
              }
            }
            throw err;
          } finally {
            if (observation) {
              try {
                observation.end();
              } catch {
                /* ignore */
              }
            }
          }
        };
        return { ...stream, result: wrappedResult };
      };

      const maybeStream = streamFn(model, context, options);
      if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
        return Promise.resolve(maybeStream).then((s) => Promise.resolve(run(s))) as ReturnType<StreamFn>;
      }
      return run(maybeStream) as ReturnType<StreamFn>;
    };
    return wrapped;
  };

  return { wrapStreamFn };
}
