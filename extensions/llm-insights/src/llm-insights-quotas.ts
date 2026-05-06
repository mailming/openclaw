import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authorizeHttpGatewayConnect,
  getBearerToken,
  isLocalDirectRequest,
  resolveGatewayAuth,
  sendGatewayAuthFailure,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "../api.js";

const MAX_BODY_BYTES = 32_000;

function setQuotasCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

type QuotaEntry = { dailyCostUsd?: number | null; monthlyCostUsd?: number | null };
type QuotasBody = { quotas: Record<string, QuotaEntry> };

function coercePositiveFinite(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

function parseQuotasBody(raw: string): QuotasBody | null {
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (!obj.quotas || typeof obj.quotas !== "object") return null;
    const out: QuotasBody = { quotas: {} };
    for (const [rawId, entry] of Object.entries(obj.quotas as Record<string, unknown>)) {
      if (!rawId.trim()) return null;
      if (!entry || typeof entry !== "object") return null;
      const e = entry as Record<string, unknown>;
      const daily = coercePositiveFinite(e.dailyCostUsd);
      const monthly = coercePositiveFinite(e.monthlyCostUsd);
      if (daily === undefined && monthly === undefined) return null;
      out.quotas[rawId] = { dailyCostUsd: daily, monthlyCostUsd: monthly };
    }
    return out;
  } catch {
    return null;
  }
}

async function assertQuotaWriteAllowed(
  api: OpenClawPluginApi,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const cfg = api.runtime.config.loadConfig();
  const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: process.env });
  const trustedProxies = cfg.gateway?.trustedProxies ?? [];
  const allowRealIpFallback = cfg.gateway?.allowRealIpFallback === true;
  const token = getBearerToken(req);
  if (auth.mode === "none") return true;
  if (
    (auth.mode === "token" || auth.mode === "password") &&
    isLocalDirectRequest(req, trustedProxies, allowRealIpFallback)
  ) {
    return true;
  }
  const result = await authorizeHttpGatewayConnect({
    auth,
    connectAuth: token ? { token, password: token } : null,
    req,
    trustedProxies,
    allowRealIpFallback,
  });
  if (!result.ok) {
    sendGatewayAuthFailure(res, result);
    return false;
  }
  return true;
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createLlmInsightsQuotasPostHandler(api: OpenClawPluginApi) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "OPTIONS") {
      setQuotasCorsHeaders(req, res);
      res.statusCode = 204;
      res.end();
      return true;
    }

    if (method !== "POST") {
      setQuotasCorsHeaders(req, res);
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Allow", "POST, OPTIONS");
      res.end("Method Not Allowed");
      return true;
    }

    setQuotasCorsHeaders(req, res);

    if (!(await assertQuotaWriteAllowed(api, req, res))) return true;

    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch {
      res.statusCode = 413;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Payload Too Large");
      return true;
    }

    const body = parseQuotasBody(raw);
    if (!body) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
      return true;
    }

    const current = api.runtime.config.loadConfig();
    const nextProviders = { ...(current.models?.providers ?? {}) };

    for (const [rawId, entry] of Object.entries(body.quotas)) {
      const providerCfg = nextProviders[rawId];
      if (!providerCfg) continue;

      const nextQuota: { dailyCostUsd?: number; monthlyCostUsd?: number } = {
        ...(providerCfg.quota ?? {}),
      };

      if (entry.dailyCostUsd === null) {
        delete nextQuota.dailyCostUsd;
      } else if (typeof entry.dailyCostUsd === "number") {
        nextQuota.dailyCostUsd = entry.dailyCostUsd;
      }

      if (entry.monthlyCostUsd === null) {
        delete nextQuota.monthlyCostUsd;
      } else if (typeof entry.monthlyCostUsd === "number") {
        nextQuota.monthlyCostUsd = entry.monthlyCostUsd;
      }

      if (Object.keys(nextQuota).length === 0) {
        const { quota: _removed, ...rest } = providerCfg;
        nextProviders[rawId] = rest as typeof providerCfg;
      } else {
        nextProviders[rawId] = { ...providerCfg, quota: nextQuota };
      }
    }

    const nextConfig = {
      ...current,
      models: { ...(current.models ?? {}), providers: nextProviders },
    };

    try {
      await api.runtime.config.writeConfigFile(nextConfig);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: msg }));
      return true;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ ok: true }));
    return true;
  };
}
