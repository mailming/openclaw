import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildLlmInsightsPayload, type InsightParams } from "./llm-insights-core.js";
import type { OpenClawPluginApi } from "../api.js";

function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseQuery(url: string | undefined): Record<string, string> {
  if (!url) {
    return {};
  }
  try {
    const u = new URL(url, "http://localhost");
    const out: Record<string, string> = {};
    u.searchParams.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  } catch {
    return {};
  }
}

function parseOptionalInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function fmtAutoPlaceholder(val: number | undefined, label: string): string {
  if (val === undefined || val === null) return label;
  return `auto: ${val}`;
}

/** Base URL for API calls and redirects when the page is shown in a blob tab (Control UI "open with auth"). */
function resolveGatewayOrigin(req: IncomingMessage): string {
  const host = req.headers.host?.trim() || "localhost";
  const xfProto = req.headers["x-forwarded-proto"];
  const firstProto =
    typeof xfProto === "string" ? xfProto.split(",")[0]?.trim().toLowerCase() : "";
  const proto = firstProto === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

export function createLlmInsightsHttpHandler(params: {
  api: OpenClawPluginApi;
  defaultDays?: number;
  defaultLimit?: number;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method not allowed");
      return true;
    }

    const q = parseQuery(req.url);
    const insightParams: InsightParams = {
      days: parseOptionalInt(q.days),
      limit: parseOptionalInt(q.limit),
      key: q.key?.trim() || undefined,
      startDate: q.startDate?.trim() || undefined,
      endDate: q.endDate?.trim() || undefined,
    };

    const result = await buildLlmInsightsPayload(params.api, insightParams, {
      defaultDays: params.defaultDays,
      defaultLimit: params.defaultLimit,
    });

    if (!result.ok) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>LLM Insights</title></head><body><p>${escapeHtml(result.error)}</p></body></html>`,
      );
      return true;
    }

    const { data } = result;
    const lat = data.sessionsUsage.aggregates.latency;
    const byModel = data.sessionsUsage.aggregates.byModel.slice(0, 25);
    const providers = data.providerUsage.providers ?? [];
    const routing = data.modelRouting;
    const quotaCfg = data.providerQuotaConfig;

    const rows = byModel
      .map((m) => {
        const lat = m.latency;
        const avg = lat ? `${Math.round(lat.avgMs)}` : "—";
        const p95 = lat ? `${Math.round(lat.p95Ms)}` : "—";
        return `<tr><td>${escapeHtml(m.provider ?? "")}</td><td>${escapeHtml(m.model ?? "")}</td><td>${escapeHtml(String(m.count))}</td><td>${escapeHtml(String(m.totals?.totalCost?.toFixed(4) ?? "0"))}</td><td>${escapeHtml(avg)}</td><td>${escapeHtml(p95)}</td></tr>`;
      })
      .join("");

    const provRows = providers
      .map((p) => {
        const pq = quotaCfg[p.displayName] ?? {};
        const vDaily = pq.dailyCostUsd !== undefined ? escapeHtml(String(pq.dailyCostUsd)) : "";
        const vMonthly = pq.monthlyCostUsd !== undefined ? escapeHtml(String(pq.monthlyCostUsd)) : "";
        const quotaInputs = `<td><input type="number" step="0.01" min="0" data-quota-field="daily" value="${vDaily}" placeholder="no limit" aria-label="daily budget USD" style="width:7rem"></td><td><input type="number" step="0.01" min="0" data-quota-field="monthly" value="${vMonthly}" placeholder="no limit" aria-label="30-day budget USD" style="width:7rem"></td>`;

        if (p.error) {
          return `<tr data-quota-provider="${escapeHtml(p.displayName)}"><td>${escapeHtml(p.displayName)}</td><td>${escapeHtml(p.plan ?? "—")}</td><td class="muted">${escapeHtml(p.error)}</td>${quotaInputs}</tr>`;
        }
        if (p.windows.length === 0) {
          return `<tr data-quota-provider="${escapeHtml(p.displayName)}"><td>${escapeHtml(p.displayName)}</td><td>${escapeHtml(p.plan ?? "—")}</td><td class="muted">no quota set · no recent usage</td>${quotaInputs}</tr>`;
        }
        const winRows = p.windows
          .map((w) => {
            const pct = Math.min(100, Math.max(0, w.usedPercent));
            const hasQuota = w.label.includes(" / ");
            if (!hasQuota) {
              return `<span class="muted">${escapeHtml(w.label)}</span>`;
            }
            const color = pct >= 100 ? "#c00" : pct >= 80 ? "#c70" : "#1a7f37";
            const bar = `<div style="background:#eee;border-radius:3px;height:8px;width:120px;display:inline-block;vertical-align:middle"><div style="background:${color};width:${pct}%;height:100%;border-radius:3px"></div></div>`;
            return `${escapeHtml(w.label)} ${bar} <span style="color:${color}">${pct}%</span>`;
          })
          .join("<br>");
        return `<tr data-quota-provider="${escapeHtml(p.displayName)}"><td>${escapeHtml(p.displayName)}</td><td>${escapeHtml(p.plan ?? "—")}</td><td>${winRows}</td>${quotaInputs}</tr>`;
      })
      .join("");

    const gatewayOriginJson = JSON.stringify(resolveGatewayOrigin(req));

    const qDays = q.days?.trim() ?? "";
    const qStart = q.startDate?.trim() ?? "";
    const qEnd = q.endDate?.trim() ?? "";
    const qLimit = q.limit?.trim() ?? "";
    const qKey = q.key?.trim() ?? "";

    const costPanelRows = data.modelCostRows
      .map((row) => {
        const o = row.override;
        const a = row.autoCost;
        const vIn = o ? escapeHtml(String(o.input)) : "";
        const vOut = o ? escapeHtml(String(o.output)) : "";
        const vCr = o ? escapeHtml(String(o.cacheRead)) : "";
        const vCw = o ? escapeHtml(String(o.cacheWrite)) : "";
        const phIn = escapeHtml(fmtAutoPlaceholder(a?.input, "in"));
        const phOut = escapeHtml(fmtAutoPlaceholder(a?.output, "out"));
        const phCr = escapeHtml(fmtAutoPlaceholder(a?.cacheRead, "cr"));
        const phCw = escapeHtml(fmtAutoPlaceholder(a?.cacheWrite, "cw"));
        return `<tr data-cost-key="${escapeHtml(row.key)}" data-had-override="${o ? "1" : "0"}"><td>${escapeHtml(row.provider)}</td><td>${escapeHtml(row.model)}</td><td><input type="number" step="any" data-field="input" value="${vIn}" placeholder="${phIn}" aria-label="override input"></td><td><input type="number" step="any" data-field="output" value="${vOut}" placeholder="${phOut}" aria-label="override output"></td><td><input type="number" step="any" data-field="cacheRead" value="${vCr}" placeholder="${phCr}" aria-label="override cache read"></td><td><input type="number" step="any" data-field="cacheWrite" value="${vCw}" placeholder="${phCw}" aria-label="override cache write"></td></tr>`;
      })
      .join("");

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LLM Insights</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1.5rem; color: #111; }
    h1 { font-size: 1.25rem; }
    h2 { font-size: 1rem; margin-top: 1.5rem; }
    table { border-collapse: collapse; width: 100%; max-width: 56rem; font-size: 0.9rem; }
    th, td { border: 1px solid #ccc; padding: 0.35rem 0.5rem; text-align: left; }
    th { background: #f4f4f4; }
    .muted { color: #555; font-size: 0.85rem; }
    .kpis { display: flex; flex-wrap: wrap; gap: 1rem; margin: 1rem 0; }
    .kpi { border: 1px solid #ddd; padding: 0.75rem 1rem; border-radius: 6px; min-width: 8rem; }
    input[type="number"] { width: 6.5rem; }
    input[type="date"] { font: inherit; }
    .llm-range-panel { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; max-width: 56rem; margin: 1rem 0; }
    .llm-presets { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-bottom: 0.75rem; }
    .llm-range-form { display: flex; flex-wrap: wrap; gap: 0.75rem 1rem; align-items: flex-end; }
    .llm-range-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; }
    button.llm-preset { padding: 0.35rem 0.65rem; font: inherit; cursor: pointer; border: 1px solid #bbb; background: #fafafa; border-radius: 4px; }
    button.llm-preset:hover { background: #eee; }
  </style>
</head>
<body>
  <h1>LLM Insights</h1>
  <p class="muted">Range: <strong>${escapeHtml(data.dateRange.startDate)}</strong> → <strong>${escapeHtml(data.dateRange.endDate)}</strong> · Models: <strong>${data.models.count}</strong> · Sessions in view: <strong>${data.sessionsUsage.sessionCount}</strong></p>
  <div class="llm-range-panel">
    <h2 style="font-size:1rem;margin:0 0 0.5rem 0">Time window</h2>
    <p class="muted" style="margin:0 0 0.5rem 0">Presets use a rolling <strong>days</strong> window (today backward). For a fixed calendar range, set start and end dates (YYYY-MM-DD) and leave <strong>Days</strong> empty. If <strong>Session limit</strong> is empty, it scales with the window (up to 500) so model totals match the range.</p>
    <div class="llm-presets">
      <span class="muted">Presets:</span>
      <button type="button" class="llm-preset" data-llm-days="7">7 days</button>
      <button type="button" class="llm-preset" data-llm-days="14">14 days</button>
      <button type="button" class="llm-preset" data-llm-days="30">30 days</button>
      <button type="button" class="llm-preset" data-llm-days="90">90 days</button>
      <button type="button" class="llm-preset" id="llm-range-reset" title="Clear days and dates (use gateway default window)">Default range</button>
    </div>
    <form id="llm-range-form" class="llm-range-form" action="#" method="get">
      <label>Days <input id="llm-inp-days" name="days" type="number" min="1" max="365" placeholder="e.g. 30" value="${escapeHtml(qDays)}"></label>
      <label>Start <input id="llm-inp-start" name="startDate" type="date" value="${escapeHtml(qStart)}"></label>
      <label>End <input id="llm-inp-end" name="endDate" type="date" value="${escapeHtml(qEnd)}"></label>
      <label>Session limit <input id="llm-inp-limit" name="limit" type="number" min="1" max="500" placeholder="auto" value="${escapeHtml(qLimit)}"></label>
      <label>Session key <input id="llm-inp-key" name="key" type="text" placeholder="optional" style="min-width:12rem" value="${escapeHtml(qKey)}"></label>
      <button type="submit" style="padding:0.4rem 0.75rem;font:inherit;cursor:pointer">Apply</button>
    </form>
  </div>
  <p class="muted">For interactive charts and filters, open the Control UI <strong>Usage</strong> tab (<code>/usage</code>) after <code>openclaw dashboard</code>.</p>
  <div class="kpis">
    <div class="kpi">Total cost (est.)<br><strong>$${escapeHtml(data.sessionsUsage.totals.totalCost.toFixed(4))}</strong></div>
    <div class="kpi">Total tokens<br><strong>${escapeHtml(String(data.sessionsUsage.totals.totalTokens))}</strong></div>
    <div class="kpi">Latency avg<br><strong>${lat ? `${Math.round(lat.avgMs)} ms` : "—"}</strong></div>
    <div class="kpi">Latency p95<br><strong>${lat ? `${Math.round(lat.p95Ms)} ms` : "—"}</strong></div>
  </div>
  <h2>Model routing</h2>
  <p class="muted">Counts how sessions reached their model. <strong>default</strong> = no cue, used configured model. <strong>@explicit</strong> = user specified a model alias. <strong>@auto</strong> = system picked based on prompt complexity.</p>
  <div class="kpis">
    ${routing.byKind.map((k) => `<div class="kpi">${escapeHtml(k.kind === "none" ? "default" : k.kind)}<br><strong>${escapeHtml(String(k.count))}</strong></div>`).join("")}${routing.autoByComplexity.length > 0 ? routing.autoByComplexity.map((c) => `<div class="kpi">@auto · ${escapeHtml(c.complexity)}<br><strong>${escapeHtml(String(c.count))}</strong></div>`).join("") : ""}${routing.byKind.length === 0 ? '<div class="kpi muted">No routing data yet</div>' : ""}
  </div>
  <h2>Manual usage pricing overrides</h2>
  <p class="muted">USD per <strong>million</strong> tokens: input / output / cache read / cache write. Values are written to <code>models.usageCostOverrides</code> in your OpenClaw config and override catalog, <code>models.json</code>, and gateway pricing cache. Leave a row blank to remove an override. If your gateway uses token or password auth, paste it below (same value as Control UI / WebSocket). If <code>gateway.auth</code> is disabled (common on loopback), leave the field empty.</p>
  <p><label class="muted" for="gw-bearer">Gateway token or password (optional)</label><br><input id="gw-bearer" type="password" autocomplete="off" style="min-width:18rem;max-width:32rem;width:100%;padding:0.35rem" placeholder="Only when gateway auth is enabled"></p>
  <p><button type="button" class="btn" id="llm-cost-save" style="padding:0.4rem 0.75rem">Save overrides to config</button> <span id="llm-cost-status" class="muted"></span></p>
  <table><thead><tr><th>Provider</th><th>Model</th><th>Input ($/M tok)</th><th>Output ($/M tok)</th><th>Cache read ($/M tok)</th><th>Cache write ($/M tok)</th></tr></thead><tbody>${costPanelRows || "<tr><td colspan=6>No catalog models</td></tr>"}</tbody></table>
  <h2>Top models by usage</h2>
  <table><thead><tr><th>Provider</th><th>Model</th><th>Turns</th><th>Est. cost</th><th>Avg/turn (ms)</th><th>p95/turn (ms)</th></tr></thead><tbody>${rows || "<tr><td colspan=6>No data</td></tr>"}</tbody></table>
  <h2>Provider quotas</h2>
  <p class="muted">Set daily or 30-day cost budgets (USD) per provider. Budgets are checked against local transcript cost estimates. When a provider hits its budget, <code>@auto</code> routing skips its models and switches to the next cheapest available provider. Leave a field empty to remove a limit.</p>
  <p><button type="button" id="llm-quota-save" style="padding:0.4rem 0.75rem;font:inherit;cursor:pointer">Save quotas</button> <span id="llm-quota-status" class="muted"></span></p>
  <table><thead><tr><th>Provider</th><th>Plan</th><th>Usage</th><th>Daily limit ($)</th><th>30-day limit ($)</th></tr></thead><tbody>${provRows || "<tr><td colspan=5>No provider usage data</td></tr>"}</tbody></table>
  <p class="muted">You can also bookmark or share this page; query parameters match the tool: <code>days</code>, <code>startDate</code>/<code>endDate</code>, <code>limit</code>, <code>key</code>.</p>
  <script>
(function(){
  var __OC_GATEWAY_ORIGIN__ = ${gatewayOriginJson};
  function llmInsightsNavigate(updates) {
    var cur = new URLSearchParams(window.location.search);
    Object.keys(updates).forEach(function (k) {
      var v = updates[k];
      if (v === null || v === undefined || v === "") {
        cur.delete(k);
      } else {
        cur.set(k, String(v));
      }
    });
    var qs = cur.toString();
    var path = "/plugins/llm-insights" + (qs ? "?" + qs : "");
    window.location.href = window.location.protocol === "blob:"
      ? new URL(path, __OC_GATEWAY_ORIGIN__).href
      : path;
  }
  function costOverridesPostUrl() {
    return window.location.protocol === "blob:"
      ? new URL("/plugins/llm-insights-cost-overrides", __OC_GATEWAY_ORIGIN__).href
      : "/plugins/llm-insights-cost-overrides";
  }
  function llmInsightsPageUrl() {
    var q = window.location.search || "";
    return window.location.protocol === "blob:"
      ? new URL("/plugins/llm-insights" + q, __OC_GATEWAY_ORIGIN__).href
      : "/plugins/llm-insights" + q;
  }
  // Pre-fill bearer field from ?_oc_token= if present, then strip from URL.
  (function() {
    var params = new URLSearchParams(window.location.search);
    var t = params.get("_oc_token");
    if (t) {
      var el = document.getElementById("gw-bearer");
      if (el && "value" in el) { el.value = t; }
      params.delete("_oc_token");
      var qs = params.toString();
      var clean = window.location.pathname + (qs ? "?" + qs : "");
      window.history.replaceState(null, "", clean);
    }
  })();
  var rangeForm = document.getElementById("llm-range-form");
  if (rangeForm) {
    rangeForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var daysEl = document.getElementById("llm-inp-days");
      var sEl = document.getElementById("llm-inp-start");
      var eEl = document.getElementById("llm-inp-end");
      var lEl = document.getElementById("llm-inp-limit");
      var kEl = document.getElementById("llm-inp-key");
      function val(el) {
        return el && "value" in el ? String(el.value || "").trim() : "";
      }
      var sd = val(sEl);
      var ed = val(eEl);
      var d = val(daysEl);
      var lim = val(lEl);
      var ky = val(kEl);
      if ((sd && !ed) || (!sd && ed)) {
        alert("Set both start and end date, or clear both to use Days.");
        return;
      }
      var upd = {};
      if (sd && ed) {
        upd.startDate = sd;
        upd.endDate = ed;
        upd.days = null;
      } else {
        upd.startDate = null;
        upd.endDate = null;
        upd.days = d || null;
      }
      upd.limit = lim || null;
      upd.key = ky || null;
      llmInsightsNavigate(upd);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll(".llm-preset[data-llm-days]"), function (btn) {
    btn.addEventListener("click", function () {
      var d = btn.getAttribute("data-llm-days");
      llmInsightsNavigate({ days: d || "", startDate: null, endDate: null });
    });
  });
  var resetBtn = document.getElementById("llm-range-reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", function () {
      llmInsightsNavigate({ days: null, startDate: null, endDate: null });
    });
  }
  const btn = document.getElementById("llm-cost-save");
  const status = document.getElementById("llm-cost-status");
  const tokenEl = document.getElementById("gw-bearer");
  function setStatus(msg) { if (status) status.textContent = msg; }
  if (!btn) return;
  btn.addEventListener("click", function () {
    var token = tokenEl && "value" in tokenEl ? String(tokenEl.value || "").trim() : "";
    var rows = Array.prototype.slice.call(document.querySelectorAll("tr[data-cost-key]"));
    var overrides = {};
    var removeKeys = [];
    function readField(tr, field) {
      var el = tr.querySelector('[data-field="' + field + '"]');
      return el && "value" in el ? String(el.value).trim() : "";
    }
    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      var key = tr.getAttribute("data-cost-key");
      if (!key) continue;
      var had = tr.getAttribute("data-had-override") === "1";
      var a = readField(tr, "input");
      var b = readField(tr, "output");
      var c = readField(tr, "cacheRead");
      var d = readField(tr, "cacheWrite");
      var allEmpty = !a && !b && !c && !d;
      var allFilled = a && b && c && d;
      if (allEmpty && had) {
        removeKeys.push(key);
      } else if (allFilled) {
        var inVal = parseFloat(a);
        var outVal = parseFloat(b);
        var crVal = parseFloat(c);
        var cwVal = parseFloat(d);
        if (![inVal, outVal, crVal, cwVal].every(function (x) { return typeof x === "number" && isFinite(x); })) {
          setStatus("Invalid numbers for " + key);
          return;
        }
        overrides[key] = { input: inVal, output: outVal, cacheRead: crVal, cacheWrite: cwVal };
      } else if (!allEmpty) {
        setStatus("Fill all four override fields for " + key + ", or clear all to remove.");
        return;
      }
    }
    setStatus("Saving\u2026");
    fetch(costOverridesPostUrl(), {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, token ? { "Authorization": "Bearer " + token } : {}),
      body: JSON.stringify({ overrides: overrides, removeKeys: removeKeys })
    }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) {
          var detail = text.slice(0, 400);
          try {
            var j = JSON.parse(text);
            if (j && typeof j.error === "string") { detail = j.error; }
            else if (j && j.error && typeof j.error === "object" && typeof j.error.message === "string") { detail = j.error.message; }
          } catch (_) {}
          setStatus("Error " + res.status + ": " + detail);
          return;
        }
        setStatus("Saved. Refreshing\u2026");
        window.location.href = llmInsightsPageUrl();
      });
    }).catch(function (e) {
      setStatus(String(e && e.message ? e.message : e));
    });
  });
  var quotaBtn = document.getElementById("llm-quota-save");
  var quotaStatus = document.getElementById("llm-quota-status");
  function setQuotaStatus(msg) { if (quotaStatus) quotaStatus.textContent = msg; }
  function quotasPostUrl() {
    return window.location.protocol === "blob:"
      ? new URL("/plugins/llm-insights-quotas", __OC_GATEWAY_ORIGIN__).href
      : "/plugins/llm-insights-quotas";
  }
  if (quotaBtn) {
    quotaBtn.addEventListener("click", function () {
      var token = tokenEl && "value" in tokenEl ? String(tokenEl.value || "").trim() : "";
      var quotaRows = Array.prototype.slice.call(document.querySelectorAll("tr[data-quota-provider]"));
      var quotas = {};
      for (var i = 0; i < quotaRows.length; i++) {
        var tr = quotaRows[i];
        var provider = tr.getAttribute("data-quota-provider");
        if (!provider) continue;
        var dEl = tr.querySelector('[data-quota-field="daily"]');
        var mEl = tr.querySelector('[data-quota-field="monthly"]');
        var dVal = dEl && "value" in dEl ? String(dEl.value).trim() : "";
        var mVal = mEl && "value" in mEl ? String(mEl.value).trim() : "";
        var entry = {};
        if (dVal === "") {
          entry.dailyCostUsd = null;
        } else {
          var dNum = parseFloat(dVal);
          if (!isFinite(dNum) || dNum < 0) { setQuotaStatus("Invalid daily budget for " + provider); return; }
          entry.dailyCostUsd = dNum;
        }
        if (mVal === "") {
          entry.monthlyCostUsd = null;
        } else {
          var mNum = parseFloat(mVal);
          if (!isFinite(mNum) || mNum < 0) { setQuotaStatus("Invalid 30-day budget for " + provider); return; }
          entry.monthlyCostUsd = mNum;
        }
        quotas[provider] = entry;
      }
      setQuotaStatus("Saving…");
      fetch(quotasPostUrl(), {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, token ? { "Authorization": "Bearer " + token } : {}),
        body: JSON.stringify({ quotas: quotas })
      }).then(function (r) {
        return r.text().then(function (text) {
          if (!r.ok) {
            var detail = text.slice(0, 400);
            try { var j = JSON.parse(text); if (j && typeof j.error === "string") detail = j.error; } catch (_) {}
            setQuotaStatus("Error " + r.status + ": " + detail);
            return;
          }
          setQuotaStatus("Saved. Refreshing…");
          window.location.href = llmInsightsPageUrl();
        });
      }).catch(function (e) { setQuotaStatus(String(e && e.message ? e.message : e)); });
    });
  }
})();
  <\/script>
</body>
</html>`;

    // Compute the SHA-256 hash of the inline script so the CSP header we send
    // explicitly allows it. This matters when the page is embedded or opened
    // under a parent frame/document that has a restrictive CSP of its own.
    const scriptMatch = /<script(?:\s[^>]*)?>([^]*?)<\/script>/i.exec(html);
    const scriptContent = scriptMatch?.[1] ?? "";
    const scriptHash = scriptContent
      ? `'sha256-${createHash("sha256").update(scriptContent, "utf8").digest("base64")}'`
      : null;
    const scriptSrc = scriptHash
      ? `script-src 'self' ${scriptHash}`
      : "script-src 'self'";
    const csp = [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self' http: https: ws: wss:",
    ].join("; ");

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("Cache-Control", "no-store");
    res.end(html);
    return true;
  };
}
