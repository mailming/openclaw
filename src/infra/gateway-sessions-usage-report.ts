import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../config/sessions/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  discoverAllSessions,
  loadSessionCostSummary,
  resolveExistingUsageSessionFile,
  type CostUsageSummary,
  type DiscoveredSession,
  type SessionDailyModelUsage,
  type SessionMessageCounts,
  type SessionModelUsage,
} from "../infra/session-cost-usage.js";
import { listAgentsForGateway, loadCombinedSessionStoreForGateway } from "../gateway/session-utils.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import {
  estimateCostBreakdownFromUsageAndPricing,
  resolveModelCostConfig,
} from "../utils/usage-format.js";
import {
  buildUsageAggregateTail,
  emptyMergedLatencyTotals,
  mergeUsageDailyLatency,
  mergeUsageLatency,
  mergedLatencyTotalsToStats,
  type MergedLatencyTotals,
} from "../shared/usage-aggregates.js";
import type {
  SessionUsageEntry,
  SessionsUsageAggregates,
  SessionsUsageResult,
} from "../shared/usage-types.js";

export type BuildSessionsUsageReportResult =
  | { ok: true; result: SessionsUsageResult }
  | { ok: false; error: "invalid_session_key"; message: string };

type DiscoveredSessionWithAgent = DiscoveredSession & { agentId: string };

export function buildStoreBySessionId(
  store: Record<string, SessionEntry>,
): Map<string, { key: string; entry: SessionEntry }> {
  const matchesBySessionId = new Map<string, Array<[string, SessionEntry]>>();
  for (const [key, entry] of Object.entries(store)) {
    if (!entry?.sessionId) {
      continue;
    }
    const matches = matchesBySessionId.get(entry.sessionId) ?? [];
    matches.push([key, entry]);
    matchesBySessionId.set(entry.sessionId, matches);
  }

  const storeBySessionId = new Map<string, { key: string; entry: SessionEntry }>();
  for (const [sessionId, matches] of matchesBySessionId) {
    const preferredKey = resolvePreferredSessionKeyForSessionIdMatches(matches, sessionId);
    if (!preferredKey) {
      continue;
    }
    const preferredEntry = store[preferredKey];
    if (preferredEntry) {
      storeBySessionId.set(sessionId, { key: preferredKey, entry: preferredEntry });
    }
  }
  return storeBySessionId;
}

export async function discoverAllSessionsForUsage(params: {
  config: OpenClawConfig;
  startMs: number;
  endMs: number;
}): Promise<DiscoveredSessionWithAgent[]> {
  const agents = listAgentsForGateway(params.config).agents;
  const results = await Promise.all(
    agents.map(async (agent) => {
      const sessions = await discoverAllSessions({
        agentId: agent.id,
        startMs: params.startMs,
        endMs: params.endMs,
      });
      return sessions.map((session) => ({ ...session, agentId: agent.id }));
    }),
  );
  return results.flat().toSorted((a, b) => b.mtime - a.mtime);
}

export async function buildSessionsUsageReport(params: {
  config: OpenClawConfig;
  startMs: number;
  endMs: number;
  limit: number;
  includeContextWeight: boolean;
  specificKey: string | null;
}): Promise<BuildSessionsUsageReportResult> {
  const { config, startMs, endMs, limit, includeContextWeight, specificKey } = params;

  const { storePath, store } = loadCombinedSessionStoreForGateway(config);
  const now = Date.now();

  type MergedEntry = {
    key: string;
    sessionId: string;
    sessionFile: string;
    label?: string;
    updatedAt: number;
    storeEntry?: SessionEntry;
  };

  const mergedEntries: MergedEntry[] = [];

  if (specificKey) {
    const parsed = parseAgentSessionKey(specificKey);
    const agentIdFromKey = parsed?.agentId;
    const keyRest = parsed?.rest ?? specificKey;

    const storeBySessionId = buildStoreBySessionId(store);

    const storeMatch = store[specificKey]
      ? { key: specificKey, entry: store[specificKey] }
      : null;
    const storeByIdMatch = storeBySessionId.get(keyRest) ?? null;
    const resolvedStoreKey = storeMatch?.key ?? storeByIdMatch?.key ?? specificKey;
    const storeEntry = storeMatch?.entry ?? storeByIdMatch?.entry;
    const sessionId = storeEntry?.sessionId ?? keyRest;

    let sessionFile: string | undefined;
    try {
      const pathOpts = resolveSessionFilePathOptions({
        storePath: storePath !== "(multiple)" ? storePath : undefined,
        agentId: agentIdFromKey,
      });
      sessionFile = resolveExistingUsageSessionFile({
        sessionId,
        sessionEntry: storeEntry,
        sessionFile: resolveSessionFilePath(sessionId, storeEntry, pathOpts),
        agentId: agentIdFromKey,
      });
    } catch {
      return {
        ok: false,
        error: "invalid_session_key",
        message: `Invalid session reference: ${specificKey}`,
      };
    }

    if (sessionFile) {
      try {
        const stats = fs.statSync(sessionFile);
        if (stats.isFile()) {
          mergedEntries.push({
            key: resolvedStoreKey,
            sessionId,
            sessionFile,
            label: storeEntry?.label,
            updatedAt: storeEntry?.updatedAt ?? stats.mtimeMs,
            storeEntry,
          });
        }
      } catch {
        // File doesn't exist - no results for this key
      }
    }
  } else {
    const discoveredSessions = await discoverAllSessionsForUsage({
      config,
      startMs,
      endMs,
    });

    const storeBySessionId = buildStoreBySessionId(store);

    for (const discovered of discoveredSessions) {
      const storeMatch = storeBySessionId.get(discovered.sessionId);
      if (storeMatch) {
        mergedEntries.push({
          key: storeMatch.key,
          sessionId: discovered.sessionId,
          sessionFile: discovered.sessionFile,
          label: storeMatch.entry.label,
          updatedAt: storeMatch.entry.updatedAt ?? discovered.mtime,
          storeEntry: storeMatch.entry,
        });
      } else {
        mergedEntries.push({
          key: `agent:${discovered.agentId}:${discovered.sessionId}`,
          sessionId: discovered.sessionId,
          sessionFile: discovered.sessionFile,
          label: undefined,
          updatedAt: discovered.mtime,
        });
      }
    }
  }

  mergedEntries.sort((a, b) => b.updatedAt - a.updatedAt);

  const limitedEntries = mergedEntries.slice(0, limit);

  const sessions: SessionUsageEntry[] = [];
  const aggregateTotals = {
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
  };
  const aggregateMessages: SessionMessageCounts = {
    total: 0,
    user: 0,
    assistant: 0,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  };
  const toolAggregateMap = new Map<string, number>();
  const byModelMap = new Map<string, SessionModelUsage>();
  const byModelLatencyTotals = new Map<string, MergedLatencyTotals>();
  const byAgentMap = new Map<string, CostUsageSummary["totals"]>();
  const byChannelMap = new Map<string, CostUsageSummary["totals"]>();
  const dailyAggregateMap = new Map<
    string,
    {
      date: string;
      tokens: number;
      cost: number;
      messages: number;
      toolCalls: number;
      errors: number;
    }
  >();
  const latencyTotals = {
    count: 0,
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: 0,
    p95Max: 0,
  };
  const dailyLatencyMap = new Map<
    string,
    { date: string; count: number; sum: number; min: number; max: number; p95Max: number }
  >();
  const modelDailyMap = new Map<string, SessionDailyModelUsage>();

  const emptyTotals = (): CostUsageSummary["totals"] => ({
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
  });
  const mergeTotals = (
    target: CostUsageSummary["totals"],
    source: CostUsageSummary["totals"],
  ) => {
    target.input += source.input;
    target.output += source.output;
    target.cacheRead += source.cacheRead;
    target.cacheWrite += source.cacheWrite;
    target.totalTokens += source.totalTokens;
    target.totalCost += source.totalCost;
    target.inputCost += source.inputCost;
    target.outputCost += source.outputCost;
    target.cacheReadCost += source.cacheReadCost;
    target.cacheWriteCost += source.cacheWriteCost;
    target.missingCostEntries += source.missingCostEntries;
  };

  for (const merged of limitedEntries) {
    const agentId = parseAgentSessionKey(merged.key)?.agentId;
    const usage = await loadSessionCostSummary({
      sessionId: merged.sessionId,
      sessionEntry: merged.storeEntry,
      sessionFile: merged.sessionFile,
      config,
      agentId,
      startMs,
      endMs,
    });

    if (usage) {
      aggregateTotals.input += usage.input;
      aggregateTotals.output += usage.output;
      aggregateTotals.cacheRead += usage.cacheRead;
      aggregateTotals.cacheWrite += usage.cacheWrite;
      aggregateTotals.totalTokens += usage.totalTokens;
      aggregateTotals.totalCost += usage.totalCost;
      aggregateTotals.inputCost += usage.inputCost;
      aggregateTotals.outputCost += usage.outputCost;
      aggregateTotals.cacheReadCost += usage.cacheReadCost;
      aggregateTotals.cacheWriteCost += usage.cacheWriteCost;
      aggregateTotals.missingCostEntries += usage.missingCostEntries;
    }

    const channel = merged.storeEntry?.channel ?? merged.storeEntry?.origin?.provider;
    const chatType = merged.storeEntry?.chatType ?? merged.storeEntry?.origin?.chatType;

    if (usage) {
      if (usage.messageCounts) {
        aggregateMessages.total += usage.messageCounts.total;
        aggregateMessages.user += usage.messageCounts.user;
        aggregateMessages.assistant += usage.messageCounts.assistant;
        aggregateMessages.toolCalls += usage.messageCounts.toolCalls;
        aggregateMessages.toolResults += usage.messageCounts.toolResults;
        aggregateMessages.errors += usage.messageCounts.errors;
      }

      if (usage.toolUsage) {
        for (const tool of usage.toolUsage.tools) {
          toolAggregateMap.set(tool.name, (toolAggregateMap.get(tool.name) ?? 0) + tool.count);
        }
      }

      if (usage.modelUsage) {
        for (const entry of usage.modelUsage) {
          const modelKey = `${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
          const modelExisting =
            byModelMap.get(modelKey) ??
            ({
              provider: entry.provider,
              model: entry.model,
              count: 0,
              totals: emptyTotals(),
            } as SessionModelUsage);
          modelExisting.count += entry.count;
          mergeTotals(modelExisting.totals, entry.totals);
          byModelMap.set(modelKey, modelExisting);

          if (entry.latency) {
            const latAcc =
              byModelLatencyTotals.get(modelKey) ?? emptyMergedLatencyTotals();
            mergeUsageLatency(latAcc, entry.latency);
            byModelLatencyTotals.set(modelKey, latAcc);
          }
        }
      }

      mergeUsageLatency(latencyTotals, usage.latency);
      mergeUsageDailyLatency(dailyLatencyMap, usage.dailyLatency);

      if (usage.dailyModelUsage) {
        for (const entry of usage.dailyModelUsage) {
          const key = `${entry.date}::${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
          const existing =
            modelDailyMap.get(key) ??
            ({
              date: entry.date,
              provider: entry.provider,
              model: entry.model,
              tokens: 0,
              cost: 0,
              count: 0,
            } as SessionDailyModelUsage);
          existing.tokens += entry.tokens;
          existing.cost += entry.cost;
          existing.count += entry.count;
          modelDailyMap.set(key, existing);
        }
      }

      if (agentId) {
        const agentTotals = byAgentMap.get(agentId) ?? emptyTotals();
        mergeTotals(agentTotals, usage);
        byAgentMap.set(agentId, agentTotals);
      }

      if (channel) {
        const channelTotals = byChannelMap.get(channel) ?? emptyTotals();
        mergeTotals(channelTotals, usage);
        byChannelMap.set(channel, channelTotals);
      }

      if (usage.dailyBreakdown) {
        for (const day of usage.dailyBreakdown) {
          const daily = dailyAggregateMap.get(day.date) ?? {
            date: day.date,
            tokens: 0,
            cost: 0,
            messages: 0,
            toolCalls: 0,
            errors: 0,
          };
          daily.tokens += day.tokens;
          daily.cost += day.cost;
          dailyAggregateMap.set(day.date, daily);
        }
      }

      if (usage.dailyMessageCounts) {
        for (const day of usage.dailyMessageCounts) {
          const daily = dailyAggregateMap.get(day.date) ?? {
            date: day.date,
            tokens: 0,
            cost: 0,
            messages: 0,
            toolCalls: 0,
            errors: 0,
          };
          daily.messages += day.total;
          daily.toolCalls += day.toolCalls;
          daily.errors += day.errors;
          dailyAggregateMap.set(day.date, daily);
        }
      }
    }

    sessions.push({
      key: merged.key,
      label: merged.label,
      sessionId: merged.sessionId,
      updatedAt: merged.updatedAt,
      agentId,
      channel,
      chatType,
      origin: merged.storeEntry?.origin,
      modelOverride: merged.storeEntry?.modelOverride,
      providerOverride: merged.storeEntry?.providerOverride,
      modelProvider: merged.storeEntry?.modelProvider,
      model: merged.storeEntry?.model,
      promptCueKind: merged.storeEntry?.promptCueKind,
      promptCueComplexity: merged.storeEntry?.promptCueComplexity,
      usage,
      contextWeight: includeContextWeight
        ? (merged.storeEntry?.systemPromptReport ?? null)
        : undefined,
    });
  }

  // Recompute per-model (and derived per-provider) cost fields from current config pricing,
  // including `models.usageCostOverrides`, so aggregates match manual estimates after edits.
  // Transcript entries carry historical costs; token totals stay authoritative.
  for (const row of byModelMap.values()) {
    const cost = resolveModelCostConfig({
      provider: row.provider,
      model: row.model,
      config,
    });
    if (!cost) {
      continue;
    }
    const breakdown = estimateCostBreakdownFromUsageAndPricing({
      usage: row.totals,
      cost,
    });
    row.totals = {
      ...row.totals,
      ...breakdown,
      missingCostEntries: 0,
    };
  }

  // Session-level `aggregateTotals` sums historical per-message costs from transcripts before
  // per-model recompute. Sum recomputed model costs so `result.totals.totalCost` matches the
  // "by model" table and `models.usageCostOverrides` / catalog pricing.
  if (byModelMap.size > 0) {
    let totalCost = 0;
    let inputCost = 0;
    let outputCost = 0;
    let cacheReadCost = 0;
    let cacheWriteCost = 0;
    let missingCostEntries = 0;
    for (const row of byModelMap.values()) {
      const t = row.totals;
      totalCost += t.totalCost ?? 0;
      inputCost += t.inputCost ?? 0;
      outputCost += t.outputCost ?? 0;
      cacheReadCost += t.cacheReadCost ?? 0;
      cacheWriteCost += t.cacheWriteCost ?? 0;
      missingCostEntries += t.missingCostEntries ?? 0;
    }
    aggregateTotals.totalCost = totalCost;
    aggregateTotals.inputCost = inputCost;
    aggregateTotals.outputCost = outputCost;
    aggregateTotals.cacheReadCost = cacheReadCost;
    aggregateTotals.cacheWriteCost = cacheWriteCost;
    aggregateTotals.missingCostEntries = missingCostEntries;
  }

  const byProviderRebuilt = new Map<string, SessionModelUsage>();
  for (const row of byModelMap.values()) {
    const providerKey = row.provider ?? "unknown";
    const existing =
      byProviderRebuilt.get(providerKey) ??
      ({
        provider: row.provider,
        model: undefined,
        count: 0,
        totals: emptyTotals(),
      } as SessionModelUsage);
    existing.count += row.count;
    mergeTotals(existing.totals, row.totals);
    byProviderRebuilt.set(providerKey, existing);
  }

  const formatDateStr = (ms: number) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  };

  const tail = buildUsageAggregateTail({
    byChannelMap: byChannelMap,
    latencyTotals,
    dailyLatencyMap,
    modelDailyMap,
    dailyMap: dailyAggregateMap,
  });

  const aggregates: SessionsUsageAggregates = {
    messages: aggregateMessages,
    tools: {
      totalCalls: Array.from(toolAggregateMap.values()).reduce((sum, count) => sum + count, 0),
      uniqueTools: toolAggregateMap.size,
      tools: Array.from(toolAggregateMap.entries())
        .map(([name, count]) => ({ name, count }))
        .toSorted((a, b) => b.count - a.count),
    },
    byModel: Array.from(byModelMap.values())
      .map((row) => {
        const k = `${row.provider ?? "unknown"}::${row.model ?? "unknown"}`;
        const merged = mergedLatencyTotalsToStats(
          byModelLatencyTotals.get(k) ?? emptyMergedLatencyTotals(),
        );
        return merged ? { ...row, latency: merged } : row;
      })
      .toSorted((a, b) => {
        const costDiff = (b.totals?.totalCost ?? 0) - (a.totals?.totalCost ?? 0);
        if (costDiff !== 0) {
          return costDiff;
        }
        return (b.totals?.totalTokens ?? 0) - (a.totals?.totalTokens ?? 0);
      }),
    byProvider: Array.from(byProviderRebuilt.values()).toSorted((a, b) => {
      const costDiff = (b.totals?.totalCost ?? 0) - (a.totals?.totalCost ?? 0);
      if (costDiff !== 0) {
        return costDiff;
      }
      return (b.totals?.totalTokens ?? 0) - (a.totals?.totalTokens ?? 0);
    }),
    byAgent: Array.from(byAgentMap.entries())
      .map(([id, totals]) => ({ agentId: id, totals }))
      .toSorted((a, b) => (b.totals?.totalCost ?? 0) - (a.totals?.totalCost ?? 0)),
    ...tail,
  };

  const result: SessionsUsageResult = {
    updatedAt: now,
    startDate: formatDateStr(startMs),
    endDate: formatDateStr(endMs),
    sessions,
    totals: aggregateTotals,
    aggregates,
  };

  return { ok: true, result };
}
