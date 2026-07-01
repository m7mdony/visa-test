export type LogEntry = { time: string; line: string };

/** Server-side cap (Grafana/Loki returns 400 if request exceeds this). */
export const LOKI_MAX_LINES_PER_QUERY = 5000;

const LOKI_RETRY_MAX_ATTEMPTS = 6;
const LOKI_RETRY_BASE_MS = 500;
/** Parallel Loki calls per report (avoids "too many outstanding requests"). */
export const LOKI_QUERY_BATCH_SIZE = 2;
const LOKI_BATCH_DELAY_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractLokiQueryError(raw: unknown): string | null {
  const o = raw as Record<string, unknown>;
  const results = o?.results as Record<string, { error?: string }> | undefined;
  if (!results || typeof results !== "object") return null;
  for (const refId of Object.keys(results)) {
    const err = results[refId]?.error;
    if (typeof err === "string" && err.trim()) return err.trim();
  }
  return null;
}

export function isRetryableLokiError(httpStatus: number, lokiError: string | null): boolean {
  if (lokiError) {
    const lower = lokiError.toLowerCase();
    if (lower.includes("too many outstanding requests")) return true;
    if (lower.includes("timeout") || lower.includes("connection reset")) return true;
    if (lower.includes("max entries limit") || lower.includes("parse error")) return false;
  }
  return httpStatus === 429 || httpStatus >= 500;
}

export async function fetchLokiQueryWithRetry(params: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  requestId?: string;
}): Promise<{ httpStatus: number; raw: unknown; logs: LogEntry[] }> {
  const label = params.requestId ?? "loki";
  let lastStatus = 0;
  let lastRaw: unknown = {};

  for (let attempt = 1; attempt <= LOKI_RETRY_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(params.url, {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.body),
      // @ts-expect-error Node fetch may accept this for self-signed certs
      rejectUnauthorized: false,
    });
    lastStatus = res.status;
    lastRaw = await res.json().catch(() => ({}));
    const lokiErr = extractLokiQueryError(lastRaw);
    const logs = parseLogsFromResponse(lastRaw);

    if (res.ok && !lokiErr) {
      return { httpStatus: res.status, raw: lastRaw, logs };
    }

    if (!isRetryableLokiError(res.status, lokiErr) || attempt >= LOKI_RETRY_MAX_ATTEMPTS) {
      return { httpStatus: res.status, raw: lastRaw, logs };
    }

    const delayMs = LOKI_RETRY_BASE_MS * 2 ** (attempt - 1);
    console.log(
      `[loki] retry ${attempt}/${LOKI_RETRY_MAX_ATTEMPTS} ${label}: ${lokiErr ?? res.status} — wait ${delayMs}ms`
    );
    await sleep(delayMs);
  }

  return { httpStatus: lastStatus, raw: lastRaw, logs: parseLogsFromResponse(lastRaw) };
}

export async function runInBatches<T>(
  tasks: Array<() => Promise<T>>,
  batchSize: number,
  delayBetweenBatchesMs = LOKI_BATCH_DELAY_MS
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const chunk = await Promise.all(batch.map((fn) => fn()));
    out.push(...chunk);
    if (i + batchSize < tasks.length && delayBetweenBatchesMs > 0) {
      await sleep(delayBetweenBatchesMs);
    }
  }
  return out;
}

/** Loki line filter (no `://` — that breaks LogQL). Matches full URL in log lines. */
export const IDNFY_STATUS_LOKI_FILTER = "appointment/idnfystatus";
/** Response lines only. */
export const IDNFY_STATUS_RESPONSE_LOKI_FILTER = "idnfystatus] Response";

const GRAFANA_URL = process.env.GRAFANA_URL ?? "";
const GRAFANA_USER = process.env.GRAFANA_USER ?? "admin";
const GRAFANA_PASSWORD = process.env.GRAFANA_PASSWORD ?? "";
export const LOKI_DATASOURCE_UID = process.env.LOKI_DATASOURCE_UID ?? "P8E80F9AEF21F6940";

export function getGrafanaBase(): string {
  return GRAFANA_URL.replace(/\/$/, "");
}

export function isGrafanaConfigured(): boolean {
  return Boolean(GRAFANA_URL);
}

function getCookieHeader(setCookie: string[]): string {
  return setCookie
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

/** Normalize Grafana/Loki line cells (string or structured JSON log). */
export function formatLogLineValue(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw == null) return "";
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.message === "string") return o.message;
    if (typeof o.msg === "string") return o.msg;
    if (typeof o.line === "string") return o.line;
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

export function parseLogsFromResponse(body: unknown): LogEntry[] {
  const logs: LogEntry[] = [];
  const o = body as Record<string, unknown>;
  const results = o?.results as Record<string, { frames?: Array<{ data?: { values?: unknown[] } }> }> | undefined;
  if (results && typeof results === "object") {
    for (const refId of Object.keys(results)) {
      const frames = results[refId]?.frames;
      if (!Array.isArray(frames)) continue;
      for (const frame of frames) {
        const values = frame?.data?.values;
        if (!Array.isArray(values) || values.length < 2) continue;
        const schema = (frame as { schema?: { fields?: Array<{ name?: string }> } })?.schema;
        let timeIdx = 0;
        let lineIdx = 1;
        if ((schema?.fields?.length ?? 0) >= 2) {
          const names = (schema?.fields ?? []).map((f) => (f?.name ?? "").toLowerCase());
          const tIdx = names.indexOf("time");
          const lIdx = names.findIndex((n) => n === "line" || n === "value");
          if (tIdx >= 0) timeIdx = tIdx;
          if (lIdx >= 0) lineIdx = lIdx;
        }
        const times = values[timeIdx] as (number | string)[];
        const lines = values[lineIdx] as unknown[];
        if (!Array.isArray(times) || !Array.isArray(lines)) continue;
        for (let i = 0; i < Math.min(times.length, lines.length); i++) {
          const t = times[i];
          let ts: number =
            typeof t === "number" && Number.isFinite(t)
              ? t
              : typeof t === "string" && /^\d+$/.test(t)
                ? parseInt(t, 10)
                : typeof t === "string"
                  ? Date.parse(t)
                  : Number(t);
          if (!Number.isFinite(ts)) continue;
          if (ts > 1e15) ts = Math.floor(ts / 1e6);
          const d = new Date(ts);
          if (!Number.isFinite(d.getTime())) continue;
          const line = formatLogLineValue(lines[i]);
          if (!line) continue;
          logs.push({ time: d.toISOString(), line });
        }
      }
    }
  }

  const data = o?.data as { result?: Array<{ values?: [string, string][] }> } | undefined;
  if (data?.result && Array.isArray(data.result) && logs.length === 0) {
    for (const stream of data.result) {
      const values = stream?.values;
      if (!Array.isArray(values)) continue;
      for (const [ns, line] of values) {
        const ts = parseInt(String(ns).slice(0, 13), 10);
        const d = new Date(ts);
        if (!Number.isFinite(d.getTime())) continue;
        logs.push({ time: d.toISOString(), line: formatLogLineValue(line) });
      }
    }
  }

  logs.sort((a, b) => a.time.localeCompare(b.time));
  return logs;
}

export function logLineHaystack(line: string): string {
  const trimmed = line.trim();
  const stripped = trimmed.replace(/^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+\w+:\s+/, "");
  return stripped === trimmed ? trimmed : `${trimmed}\n${stripped}`;
}

export function parseIdnfyStatusFromLine(line: string): "APPROVED" | "DENIED" | null {
  const hay = logLineHaystack(line);
  if (/"status"\s*:\s*"APPROVED"/i.test(hay) || /'status'\s*:\s*'APPROVED'/i.test(hay)) return "APPROVED";
  if (/"status"\s*:\s*"DENIED"/i.test(hay) || /'status'\s*:\s*'DENIED'/i.test(hay)) return "DENIED";
  if (/\bstatus=APPROVED\b/i.test(hay)) return "APPROVED";
  if (/\bstatus=DENIED\b/i.test(hay)) return "DENIED";
  return null;
}

export function isIdnfyStatusResponseLine(line: string): boolean {
  const hay = logLineHaystack(line);
  const status = parseIdnfyStatusFromLine(line);
  const hasEndpoint =
    hay.includes(IDNFY_STATUS_LOKI_FILTER) ||
    /appointment\/idnfystatus/i.test(hay) ||
    /idnfystatus\]/i.test(hay);
  if (status) {
    return hasEndpoint || /"aurn"\s*:/i.test(hay) || /"requestRefNumber"\s*:/i.test(hay);
  }
  if (!hasEndpoint) return false;
  return /idnfystatus\]\s*Response/i.test(hay) || /Response:\s*\{/i.test(hay);
}

export function isIdnfyStatusApprovedLine(line: string): boolean {
  return isIdnfyStatusResponseLine(line) && parseIdnfyStatusFromLine(line) === "APPROVED";
}

export function isIdnfyStatusDeniedLine(line: string): boolean {
  return isIdnfyStatusResponseLine(line) && parseIdnfyStatusFromLine(line) === "DENIED";
}

export function isErroredVideoAttemptLine(line: string): boolean {
  const hay = logLineHaystack(line);
  return /Attempt\s+\d+(?:\s*\/\s*\d+)?\s*:\s*failed/i.test(hay);
}

function escapeLogQLLineFilter(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Build `{app=…} |= "…"` filters. Uses double quotes (backticks + `://` cause Loki 400). */
export function buildLokiLineFilterExpr(
  selector: string,
  filters: string | string[]
): string {
  const parts = (Array.isArray(filters) ? filters : [filters]).filter((f) => f.trim().length > 0);
  let expr = selector;
  for (const f of parts) {
    expr += ` |= "${escapeLogQLLineFilter(f)}"`;
  }
  return expr;
}

export async function loginGrafanaCookie(base: string): Promise<string> {
  const loginUrl = `${base}/login`;
  const loginRes = await fetch(loginUrl, {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; UiTest-Loki/1.0)",
      Accept: "application/json",
      "Content-Type": "application/json",
      Referer: loginUrl,
    },
    body: JSON.stringify({
      user: GRAFANA_USER,
      password: GRAFANA_PASSWORD,
    }),
    redirect: "manual",
    // @ts-expect-error Node fetch may accept this for self-signed
    rejectUnauthorized: false,
  });
  let setCookie: string[] = [];
  if (typeof loginRes.headers.getSetCookie === "function") {
    setCookie = loginRes.headers.getSetCookie();
  } else {
    const sc = loginRes.headers.get("set-cookie");
    if (sc) setCookie = [sc];
  }
  return getCookieHeader(setCookie);
}

export async function queryVfsGlobalBotLogs(params: {
  base: string;
  cookieHeader: string;
  from: number;
  to: number;
  query: string | string[];
  requestId: string;
  app?: string;
  maxLines?: number;
}): Promise<LogEntry[]> {
  const {
    base,
    cookieHeader,
    from,
    to,
    query,
    requestId,
    app = "vfs-global-bot",
    maxLines = LOKI_MAX_LINES_PER_QUERY,
  } = params;
  const cappedMaxLines = Math.min(maxLines, LOKI_MAX_LINES_PER_QUERY);
  const expr = buildLokiLineFilterExpr(`{app="${app.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"}`, query);
  const queryBody = {
    queries: [
      {
        expr,
        queryType: "range",
        refId: "logs",
        maxLines: cappedMaxLines,
        direction: "backward",
        datasource: { type: "loki", uid: LOKI_DATASOURCE_UID },
        datasourceId: 1,
        intervalMs: to - from,
      },
    ],
    from: String(from),
    to: String(to),
  };
  const { logs } = await fetchLokiQueryWithRetry({
    url: `${base}/api/ds/query?ds_type=loki&requestId=${encodeURIComponent(requestId)}`,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; UiTest-Loki/1.0)",
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      Origin: base,
      "x-datasource-uid": LOKI_DATASOURCE_UID,
      "x-grafana-org-id": "1",
      "x-plugin-id": "loki",
      "x-query-group-id": "ui-test-loki",
    },
    body: queryBody,
    requestId,
  });
  return logs;
}

export function extractPassportFromLine(line: string): string | null {
  const patterns = [
    /\bPassportNumber=([^\s,}\]]+)/i,
    /\bpassportNumber=([^\s,}\]]+)/i,
    /\bpassport=([^\s,}\]]+)/i,
    /"passportNumber"\s*:\s*"([^"]*)"/i,
    /"passport"\s*:\s*"([^"]*)"/i,
    /\[passport=([^\]]+)\]/i,
  ];
  for (const re of patterns) {
    const m = line.match(re);
    if (!m?.[1]) continue;
    const v = m[1].trim().replace(/^["']|["']$/g, "");
    if (!v || /^null$/i.test(v) || /^undefined$/i.test(v) || v === "-" || v === "N/A") continue;
    return v;
  }
  return null;
}

export function resolvePassportFromEmailLogs(email: string, logs: LogEntry[]): string | null {
  const needle = email.toLowerCase();
  let found: string | null = null;
  for (const entry of logs) {
    if (!entry.line.toLowerCase().includes(needle)) continue;
    const passport = extractPassportFromLine(entry.line);
    if (passport) found = passport;
  }
  return found;
}
