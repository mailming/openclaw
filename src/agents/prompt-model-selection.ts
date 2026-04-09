import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.js";
import {
  buildAllowedModelSet,
  buildConfiguredModelCatalog,
  buildModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveAllowedModelRef,
  resolveDefaultModelForAgent,
  type ModelRef,
} from "./model-selection.js";

export type PromptModelCueResolution =
  | {
      kind: "none";
      prompt: string;
    }
  | {
      kind: "explicit";
      rawCue: string;
      key: string;
      ref: ModelRef;
      alias?: string;
      prompt: string;
    }
  | {
      kind: "auto";
      rawCue: string;
      key: string;
      ref: ModelRef;
      complexity: "simple" | "complex";
      complexityScore: number;
      prompt: string;
    };

type AutoModelCandidate = {
  key: string;
  ref: ModelRef;
  totalCost: number;
  reasoning: boolean;
  contextWindow: number;
};

function extractLeadingPromptCue(prompt: string): { rawCue: string; value: string; rest: string } | null {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith("@")) {
    return null;
  }
  const match = /^@([^\s]+)([\s\S]*)$/u.exec(trimmed);
  if (!match) {
    return null;
  }
  const rawCue = `@${match[1]}`;
  const value = match[1];
  const rest = match[2].trimStart();
  return { rawCue, value, rest };
}

function resolveTotalCost(cost: ModelDefinitionConfig["cost"] | undefined): number {
  if (!cost) {
    return Number.POSITIVE_INFINITY;
  }
  const values = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    return Number.POSITIVE_INFINITY;
  }
  return values.reduce((sum, value) => sum + value, 0);
}

function scorePromptComplexity(prompt: string): number {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return 0;
  }

  let score = 0;
  const lines = trimmed.split(/\r?\n/u);

  if (trimmed.length > 1200) {
    score += 3;
  } else if (trimmed.length > 400) {
    score += 2;
  } else if (trimmed.length > 180) {
    score += 1;
  }

  if (lines.length > 30) {
    score += 3;
  } else if (lines.length > 10) {
    score += 2;
  } else if (lines.length > 4) {
    score += 1;
  }

  if (/```|diff --git|Traceback|Exception:|Error:|stack trace/iu.test(trimmed)) {
    score += 2;
  }
  if (/\b(src|app|tests?|docs|packages?|extensions)\/[\w./-]+|\b[\w.-]+\.(ts|tsx|js|jsx|json|md|py|go|rs|java|kt|swift|yaml|yml)\b/u.test(trimmed)) {
    score += 1;
  }
  if (
    /\b(implement|debug|fix|patch|refactor|review|analyze|investigate|trace|migrate|design|architect|benchmark|optimize|test)\b/iu.test(
      trimmed,
    )
  ) {
    score += 2;
  }
  if (/\b(explain|summarize|rewrite|translate|draft|brainstorm|title)\b/iu.test(trimmed)) {
    score -= 1;
  }

  return Math.max(0, score);
}

function classifyPromptComplexity(score: number): "simple" | "complex" {
  return score >= 4 ? "complex" : "simple";
}

function compareAutoModelCandidates(a: AutoModelCandidate, b: AutoModelCandidate): number {
  if (a.totalCost !== b.totalCost) {
    return a.totalCost - b.totalCost;
  }
  if (a.reasoning !== b.reasoning) {
    return Number(a.reasoning) - Number(b.reasoning);
  }
  if (a.contextWindow !== b.contextWindow) {
    return a.contextWindow - b.contextWindow;
  }
  return a.key.localeCompare(b.key);
}

function buildAutoModelCandidates(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
  agentId?: string;
  requiresImage: boolean;
}): AutoModelCandidate[] {
  const providers = params.cfg.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }

  const catalog = buildConfiguredModelCatalog({ cfg: params.cfg });
  const allowed = buildAllowedModelSet({
    cfg: params.cfg,
    catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    agentId: params.agentId,
  });

  const candidates: AutoModelCandidate[] = [];
  for (const [providerRaw, provider] of Object.entries(providers)) {
    const providerId = normalizeProviderId(providerRaw);
    if (!providerId || !Array.isArray(provider?.models)) {
      continue;
    }
    for (const model of provider.models) {
      const modelId = typeof model?.id === "string" ? model.id.trim() : "";
      if (!modelId) {
        continue;
      }
      const key = modelKey(providerId, modelId);
      if (!allowed.allowAny && !allowed.allowedKeys.has(key)) {
        continue;
      }
      if (params.requiresImage && !model.input?.includes("image")) {
        continue;
      }
      candidates.push({
        key,
        ref: { provider: providerId, model: modelId },
        totalCost: resolveTotalCost(model.cost),
        reasoning: model.reasoning === true,
        contextWindow:
          typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
            ? model.contextWindow
            : Number.MAX_SAFE_INTEGER,
      });
    }
  }

  candidates.sort(compareAutoModelCandidates);
  return candidates;
}

function resolveAutoModelCue(params: {
  cfg: OpenClawConfig;
  prompt: string;
  defaultProvider: string;
  defaultModel: string;
  agentId?: string;
  requiresImage: boolean;
  rawCue: string;
}): PromptModelCueResolution {
  const defaultRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const defaultKey = modelKey(defaultRef.provider, defaultRef.model);
  const candidates = buildAutoModelCandidates(params);
  const complexityScore = scorePromptComplexity(params.prompt);
  const complexity = classifyPromptComplexity(complexityScore);
  const defaultCandidate = candidates.find((candidate) => candidate.key === defaultKey);
  const selectedCandidate =
    complexity === "complex"
      ? (defaultCandidate ?? candidates[0])
      : (() => {
          const cheapest = candidates[0];
          if (!cheapest) {
            return undefined;
          }
          if (!defaultCandidate) {
            return cheapest;
          }
          return cheapest.totalCost < defaultCandidate.totalCost ? cheapest : defaultCandidate;
        })();

  const selectedRef = selectedCandidate?.ref ?? defaultRef;
  const selectedKey = selectedCandidate?.key ?? defaultKey;

  return {
    kind: "auto",
    rawCue: params.rawCue,
    key: selectedKey,
    ref: selectedRef,
    complexity,
    complexityScore,
    prompt: params.prompt,
  };
}

export function resolvePromptModelCue(params: {
  cfg?: OpenClawConfig;
  prompt: string;
  defaultProvider: string;
  defaultModel: string;
  agentId?: string;
  requiresImage?: boolean;
}): PromptModelCueResolution {
  const cue = extractLeadingPromptCue(params.prompt);
  if (!cue) {
    return { kind: "none", prompt: params.prompt };
  }

  const cfg = (params.cfg ?? {}) as OpenClawConfig;
  const defaultProvider = params.defaultProvider.trim();
  const defaultModel = params.defaultModel.trim();

  if (cue.value.toLowerCase() === "auto") {
    return resolveAutoModelCue({
      cfg,
      prompt: cue.rest,
      defaultProvider,
      defaultModel,
      agentId: params.agentId,
      requiresImage: params.requiresImage === true,
      rawCue: cue.rawCue,
    });
  }

  const catalog = buildConfiguredModelCatalog({ cfg });
  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider,
  });
  const allowed = resolveAllowedModelRef({
    cfg,
    catalog,
    raw: cue.value,
    defaultProvider,
    defaultModel,
  });
  if ("error" in allowed) {
    return { kind: "none", prompt: params.prompt };
  }

  const alias = aliasIndex.byKey
    .get(allowed.key)
    ?.find((candidateAlias) => candidateAlias.toLowerCase() === cue.value.toLowerCase());

  return {
    kind: "explicit",
    rawCue: cue.rawCue,
    key: allowed.key,
    ref: allowed.ref,
    alias,
    prompt: cue.rest,
  };
}
