import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@sinclair/typebox", () => ({
  Type: {
    Object: (schema: unknown) => schema,
    String: (schema?: unknown) => schema,
    Optional: (schema: unknown) => schema,
    Number: (schema?: unknown) => schema,
  },
}));

vi.mock("openclaw/plugin-sdk/gateway-model-catalog", () => ({
  DEFAULT_PROVIDER: "anthropic",
  loadGatewayModelCatalog: vi.fn(async () => [
    { provider: "anthropic", id: "claude-sonnet-4" },
  ]),
  buildAllowedModelSet: vi.fn(() => ({ allowedCatalog: [] })),
}));

vi.mock("openclaw/plugin-sdk/gateway-usage-date-range", () => ({
  DAY_MS: 24 * 60 * 60 * 1000,
  parseDateRange: vi.fn(() => ({ startMs: 0, endMs: 1 })),
}));

vi.mock("openclaw/plugin-sdk/model-cost", () => ({
  modelKey: (p: string, m: string) => `${p}/${m}`,
  normalizeModelRef: (p: string, m: string) => ({ provider: p, model: m }),
  resolveModelCostConfig: vi.fn(() => undefined),
}));

vi.mock("openclaw/plugin-sdk/usage-cost", () => ({
  loadCostUsageSummary: vi.fn(async () => ({
    updatedAt: 1,
    days: 1,
    daily: [],
    totals: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    },
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-usage", () => ({
  loadProviderUsageSummary: vi.fn(async () => ({
    updatedAt: 1,
    providers: [],
  })),
}));

vi.mock("openclaw/plugin-sdk/sessions-usage-report", () => ({
  buildSessionsUsageReport: vi.fn(async () => ({
    ok: true as const,
    result: {
      updatedAt: 1,
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      sessions: [],
      totals: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        totalCost: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
      },
      aggregates: {
        messages: {
          total: 0,
          user: 0,
          assistant: 0,
          toolCalls: 0,
          toolResults: 0,
          errors: 0,
        },
        tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
      },
    },
  })),
}));

import { createLlmInsightsOverviewTool } from "./llm-insights-tool.js";

function fakeApi() {
  const config = {
    agents: { defaults: { workspace: "/tmp", model: { primary: "anthropic/claude-sonnet-4" } } },
  };
  return {
    id: "llm-insights",
    name: "LLM Insights",
    source: "test",
    config,
    pluginConfig: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerTool() {},
    runtime: {
      config: {
        loadConfig: () => config,
      },
    },
  };
}

describe("llm-insights tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes llm_insights_overview", () => {
    const tool = createLlmInsightsOverviewTool(fakeApi() as never);
    expect(tool.name).toBe("llm_insights_overview");
  });

  it("returns JSON payload on success", async () => {
    const tool = createLlmInsightsOverviewTool(fakeApi() as never);
    const out = await tool.execute("t1", { days: 7 });
    expect(out.content[0]?.type).toBe("text");
    const parsed = JSON.parse(out.content[0]?.text ?? "{}") as { models?: { count?: number } };
    expect(parsed.models?.count).toBe(1);
  });
});
