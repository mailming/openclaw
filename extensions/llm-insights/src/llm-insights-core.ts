import {
  buildAllowedModelSet,
  DEFAULT_PROVIDER,
  loadGatewayModelCatalog,
} from "openclaw/plugin-sdk/gateway-model-catalog";
import { DAY_MS, parseDateRange } from "openclaw/plugin-sdk/gateway-usage-date-range";
import {
  modelKey,
  normalizeModelRef,
  resolveModelCostConfig,
  type ModelCostConfig,
} from "openclaw/plugin-sdk/model-cost";
import { loadProviderUsageSummary } from "openclaw/plugin-sdk/provider-usage";
import { buildSessionsUsageReport } from "openclaw/plugin-sdk/sessions-usage-report";
import type { SessionsUsageResult } from "openclaw/plugin-sdk/sessions-usage-report";
import { loadCostUsageSummary } from "openclaw/plugin-sdk/usage-cost";
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

  const [costSummary, providerUsage, sessionsReport] = await Promise.all([
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
      providerUsage,
      sessionsUsage: {
        totals: sessionsReport.result.totals,
        aggregates: sessionsReport.result.aggregates,
        sessionCount: sessionsReport.result.sessions.length,
        sessionKeys: sessionsReport.result.sessions.slice(0, 20).map((s) => s.key),
      },
      modelCostRows: buildModelCostRows(cfg, models),
    },
  };
}
