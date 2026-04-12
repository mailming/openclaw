import { describe, it, expect, vi, beforeEach } from "vitest";

const { buildSessionsUsageReportMock } = vi.hoisted(() => ({
  buildSessionsUsageReportMock: vi.fn(async () => ({
    ok: true as const,
    result: {
      updatedAt: 1,
      startDate: "2026-01-01",
      endDate: "2026-04-01",
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

vi.mock("openclaw/plugin-sdk/gateway-model-catalog", () => ({
  DEFAULT_PROVIDER: "anthropic",
  loadGatewayModelCatalog: vi.fn(async () => [{ provider: "anthropic", id: "claude-sonnet-4" }]),
  buildAllowedModelSet: vi.fn(() => ({ allowedCatalog: [] })),
}));

vi.mock("openclaw/plugin-sdk/gateway-usage-date-range", async () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return {
    DAY_MS,
    parseDateRange: vi.fn(() => ({
      startMs: 0,
      endMs: 90 * DAY_MS - 1,
    })),
  };
});

vi.mock("openclaw/plugin-sdk/model-cost", () => ({
  modelKey: (p: string, m: string) => `${p}/${m}`,
  normalizeModelRef: (p: string, m: string) => ({ provider: p, model: m }),
  resolveModelCostConfig: vi.fn(() => undefined),
}));

vi.mock("openclaw/plugin-sdk/usage-cost", () => ({
  loadCostUsageSummary: vi.fn(async () => ({
    updatedAt: 1,
    days: 90,
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
  loadProviderUsageSummary: vi.fn(async () => ({ updatedAt: 1, providers: [] })),
}));

vi.mock("openclaw/plugin-sdk/sessions-usage-report", () => ({
  buildSessionsUsageReport: buildSessionsUsageReportMock,
}));

import { buildLlmInsightsPayload } from "./llm-insights-core.js";

function fakeApi() {
  const config = {
    agents: { defaults: { workspace: "/tmp", model: { primary: "anthropic/claude-sonnet-4" } } },
  };
  return {
    id: "llm-insights",
    runtime: { config: { loadConfig: () => config } },
    config,
  };
}

describe("buildLlmInsightsPayload session limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSessionsUsageReportMock.mockClear();
  });

  it("scales default session limit with long windows so aggregates cover the range", async () => {
    const result = await buildLlmInsightsPayload(fakeApi() as never, { days: 90 }, {});
    expect(result.ok).toBe(true);
    expect(buildSessionsUsageReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 500,
      }),
    );
  });

  it("respects an explicit limit cap", async () => {
    await buildLlmInsightsPayload(fakeApi() as never, { days: 90, limit: 80 }, {});
    expect(buildSessionsUsageReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 80,
      }),
    );
  });
});
