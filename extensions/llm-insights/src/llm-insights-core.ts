import {
  buildAllowedModelSet,
  DEFAULT_PROVIDER,
  loadGatewayModelCatalog,
} from "openclaw/plugin-sdk/gateway-model-catalog";
import { DAY_MS, getTodayStartMs, parseDateRange } from "openclaw/plugin-sdk/gateway-usage-date-range";
import {
  modelKey,
  normalizeModelRef,
  resolveModelCostConfig,
  type ModelCostConfig,
} from "openclaw/plugin-sdk/model-cost";
import { loadProviderUsageSummary } from "openclaw/plugin-sdk/provider-usage";
import type { ProviderUsageSnapshot } from "openclaw/plugin-sdk/provider-usage";
import { buildSessionsUsageReport } from "openclaw/plugin-sdk/sessions-usage-report";
import type { SessionsUsageResult } from "openclaw/plugin-sdk/sessions-usage-report";
import { loadCostUsageSummary, loadProviderCostUsed } from "openclaw/plugin-sdk/usage-cost";
import type { OpenClawPluginApi } from "../api.js";

export type InsightParams = {
  days?: number;
  startDate?: string;
  endDate?: string;
  limit?: number;
  key?: string;
};

export type LlmInsightsPayload =
  | {
      ok: true;
      data: {
        dateRange: { startDate: string; endDate: string };
        models: { count: number; items: Array<{ provider: string; id: string }> };
        costSummary: Awaited<ReturnType<typeof loadCostUsageSummary>>;
        providerUsage: Awaited<ReturnType<typeof loadProviderUsageSummary>>;
        sessionsUsage: {
          totals: SessionsUsageResult["totals"];
          aggregates: SessionsUsageResult["aggregates"];
          sessionCount: number;
          sessionKeys: string[];
        };
        /** Catalog models with auto-resolved pricing vs manual `models.usageCostOverrides` (first N models). */
        modelCostRows: Array<{
          provider: string;
          model: string;
          key: string;
          autoCost?: ModelCostConfig;
          override?: ModelCostConfig;
        }>;
        /** Aggregate counts of how sessions reached their model (default, explicit @cue, or @auto routing). */
        modelRouting: {
          total: number;
          byKind: Array<{ kind: "none" | "explicit" | "auto"; count: number }>;
          autoByComplexity: Array<{ complexity: "simple" | "complex"; count: number }>;
        };
        /** Current quota config per provider (raw config key → quota values). Used to pre-fill the quota editor. */
        providerQuotaConfig: Record<string, { dailyCostUsd?: number; monthlyCostUsd?: number }>;
      };
    }
  | { ok: false; error: string };

const MODEL_COST_PANEL_LIMIT = 80;

/** Matches `llm_insights_overview` tool and HTTP `?limit=` max. */
const SESSIONS_REPORT_MAX_LIMIT = 500;

/**
 * `loadCostUsageSummary` scans all transcripts in range, but `buildSessionsUsageReport` only
 * aggregates up to `limit` sessions (by recency). Scale the default limit with window length so
 * "top models" tracks the selected range instead of sticking to the same newest ~50 sessions.
 */
function resolveSessionsReportLimit(
  params: InsightParams,
  startMs: number,
  endMs: number,
  options: { defaultLimit?: number },
): number {
  if (params.limit !== undefined) {
    return Math.min(SESSIONS_REPORT_MAX_LIMIT, Math.max(1, Math.floor(params.limit)));
  }
  const baseDefault = options.defaultLimit ?? 50;
  const spanDays = Math.max(1, Math.floor((endMs - startMs) / DAY_MS) + 1);
  return Math.min(
    SESSIONS_REPORT_MAX_LIMIT,
    Math.max(baseDefault, spanDays * 6),
  );
}

function buildModelCostRows(
  cfg: OpenClawPluginApi["config"],
  catalogModels: Array<{ provider: string; id: string }>,
): Array<{
  provider: string;
  model: string;
  key: string;
  autoCost?: ModelCostConfig;
  override?: ModelCostConfig;
}> {
  const cfgStrip = {
    ...cfg,
    models: cfg.models ? { ...cfg.models, usageCostOverrides: undefined } : undefined,
  };
  return catalogModels.slice(0, MODEL_COST_PANEL_LIMIT).map((m) => {
    const normalized = normalizeModelRef(m.provider, m.id);
    const key = modelKey(normalized.provider, normalized.model);
    return {
      provider: m.provider,
      model: m.id,
      key,
      autoCost: resolveModelCostConfig({
        provider: m.provider,
        model: m.id,
        config: cfgStrip,
      }),
      override: cfg.models?.usageCostOverrides?.[key],
    };
  });
}

function buildModelRoutingStats(sessions: SessionsUsageResult["sessions"]): {
  total: number;
  byKind: Array<{ kind: "none" | "explicit" | "auto"; count: number }>;
  autoByComplexity: Array<{ complexity: "simple" | "complex"; count: number }>;
} {
  const kindCounts = new Map<"none" | "explicit" | "auto", number>();
  const complexityCounts = new Map<"simple" | "complex", number>();
  for (const s of sessions) {
    const kind: "none" | "explicit" | "auto" = s.promptCueKind ?? "none";
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
    if (kind === "auto" && s.promptCueComplexity) {
      complexityCounts.set(
        s.promptCueComplexity,
        (complexityCounts.get(s.promptCueComplexity) ?? 0) + 1,
      );
    }
  }
  return {
    total: sessions.length,
    byKind: (["none", "explicit", "auto"] as const)
      .filter((k) => kindCounts.has(k))
      .map((kind) => ({ kind, count: kindCounts.get(kind) ?? 0 })),
    autoByComplexity: (["simple", "complex"] as const)
      .filter((c) => complexityCounts.has(c))
      .map((complexity) => ({ complexity, count: complexityCounts.get(complexity) ?? 0 })),
  };
}

async function buildManualQuotaSnapshots(
  cfg: OpenClawPluginApi["config"],
): Promise<ProviderUsageSnapshot[]> {
  const providers = cfg.models?.providers;
  if (!providers || typeof providers !== "object") return [];
  const providerEntries = Object.entries(providers);
  if (providerEntries.length === 0) return [];

  const now = Date.now();
  const todayStartMs = getTodayStartMs(new Date(now), { mode: "gateway" });
  const MONTH_MS = 30 * DAY_MS;
  const [dailyMap, monthlyMap] = await Promise.all([
    loadProviderCostUsed({ startMs: todayStartMs, endMs: now, config: cfg }),
    loadProviderCostUsed({ startMs: now - MONTH_MS, endMs: now, config: cfg }),
  ]);

  const fmtUsd = (v: number) => `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;

  const snapshots: ProviderUsageSnapshot[] = [];
  for (const [rawId, providerCfg] of providerEntries) {
    const id = rawId.toLowerCase().trim();
    const dailyCost = dailyMap.get(id) ?? 0;
    const monthlyCost = monthlyMap.get(id) ?? 0;
    const windows = [];

    if (providerCfg.quota?.dailyCostUsd) {
      windows.push({
        label: `Daily (${fmtUsd(dailyCost)} / ${fmtUsd(providerCfg.quota.dailyCostUsd)})`,
        usedPercent: Math.min(100, Math.round((dailyCost / providerCfg.quota.dailyCostUsd) * 100)),
      });
    } else if (dailyCost > 0) {
      windows.push({ label: `Today: ${fmtUsd(dailyCost)}`, usedPercent: 0 });
    }

    if (providerCfg.quota?.monthlyCostUsd) {
      windows.push({
        label: `30-day (${fmtUsd(monthlyCost)} / ${fmtUsd(providerCfg.quota.monthlyCostUsd)})`,
        usedPercent: Math.min(100, Math.round((monthlyCost / providerCfg.quota.monthlyCostUsd) * 100)),
      });
    } else if (monthlyCost > 0 && !providerCfg.quota?.dailyCostUsd) {
      windows.push({ label: `30-day: ${fmtUsd(monthlyCost)}`, usedPercent: 0 });
    }

    snapshots.push({
      provider: id as ProviderUsageSnapshot["provider"],
      displayName: rawId,
      windows,
    });
  }
  return snapshots;
}

function buildProviderQuotaConfig(
  cfg: OpenClawPluginApi["config"],
): Record<string, { dailyCostUsd?: number; monthlyCostUsd?: number }> {
  const out: Record<string, { dailyCostUsd?: number; monthlyCostUsd?: number }> = {};
  const providers = cfg.models?.providers;
  if (!providers || typeof providers !== "object") return out;
  for (const [rawId, providerCfg] of Object.entries(providers)) {
    out[rawId] = {
      dailyCostUsd: providerCfg.quota?.dailyCostUsd,
      monthlyCostUsd: providerCfg.quota?.monthlyCostUsd,
    };
  }
  return out;
}

export async function buildLlmInsightsPayload(
  api: OpenClawPluginApi,
  params: InsightParams,
  options: { defaultDays?: number; defaultLimit?: number } = {},
): Promise<LlmInsightsPayload> {
  // Use runtime loadConfig so manual edits (e.g. usage cost overrides saved via HTTP) are visible
  // on the next page load. `api.config` is the registration-time snapshot and can stay stale.
  const cfg = api.runtime.config.loadConfig();
  const days = params.days ?? options.defaultDays;
  const { startMs, endMs } = parseDateRange({
    startDate: params.startDate,
    endDate: params.endDate,
    days,
  });

  const catalog = await loadGatewayModelCatalog();
  const { allowedCatalog } = buildAllowedModelSet({
    cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const models = (allowedCatalog.length > 0 ? allowedCatalog : catalog).map((m) => ({
    provider: m.provider,
    id: m.id,
  }));

  const limit = resolveSessionsReportLimit(params, startMs, endMs, {
    defaultLimit: options.defaultLimit,
  });

  const [costSummary, providerUsage, sessionsReport, manualQuotaSnapshots] = await Promise.all([
    loadCostUsageSummary({ startMs, endMs, config: cfg }),
    loadProviderUsageSummary({ config: cfg }),
    buildSessionsUsageReport({
      config: cfg,
      startMs,
      endMs,
      limit,
      includeContextWeight: false,
      specificKey: params.key?.trim() ? params.key.trim() : null,
    }),
    buildManualQuotaSnapshots(cfg),
  ]);

  if (!sessionsReport.ok) {
    return { ok: false, error: sessionsReport.message };
  }

  return {
    ok: true,
    data: {
      dateRange: {
        startDate: sessionsReport.result.startDate,
        endDate: sessionsReport.result.endDate,
      },
      models: {
        count: models.length,
        items: models.slice(0, 500),
      },
      costSummary,
      providerUsage: {
        ...providerUsage,
        providers: [
          ...manualQuotaSnapshots,
          ...providerUsage.providers.filter(
            (p) => !manualQuotaSnapshots.some((m) => m.provider === p.provider),
          ),
        ],
      },
      sessionsUsage: {
        totals: sessionsReport.result.totals,
        aggregates: sessionsReport.result.aggregates,
        sessionCount: sessionsReport.result.sessions.length,
        sessionKeys: sessionsReport.result.sessions.slice(0, 20).map((s) => s.key),
      },
      modelCostRows: buildModelCostRows(cfg, models),
      modelRouting: buildModelRoutingStats(sessionsReport.result.sessions),
      providerQuotaConfig: buildProviderQuotaConfig(cfg),
    },
  };
}
