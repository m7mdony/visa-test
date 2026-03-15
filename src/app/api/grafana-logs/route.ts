import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

const GRAFANA_URL = process.env.GRAFANA_URL ?? "";
const GRAFANA_USER = process.env.GRAFANA_USER ?? "admin";
const GRAFANA_PASSWORD = process.env.GRAFANA_PASSWORD ?? "";
const LOKI_DATASOURCE_UID = process.env.LOKI_DATASOURCE_UID ?? "P8E80F9AEF21F6940";

const INTERVAL_MS: Record<string, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

function getCookieHeader(setCookie: string[]): string {
  return setCookie
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function parseLogsFromResponse(body: unknown): { time: string; line: string }[] {
  const logs: { time: string; line: string }[] = [];
  const o = body as Record<string, unknown>;

  // Grafana datasource proxy: results[refId].frames[].data.values
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
        const lines = values[lineIdx] as string[];
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
          const date = new Date(ts);
          const timeStr = Number.isFinite(date.getTime()) ? date.toISOString() : "";
          const rawLine = lines[i];
          const lineStr =
            typeof rawLine === "string"
              ? rawLine
              : rawLine != null && typeof rawLine === "object"
                ? JSON.stringify(rawLine)
                : String(rawLine ?? "");
          logs.push({
            time: timeStr,
            line: lineStr,
          });
        }
      }
    }
  }

  // Loki-style: data.result[].values
  const data = o?.data as { result?: Array<{ values?: [string, string][] }> } | undefined;
  if (data?.result && Array.isArray(data.result) && logs.length === 0) {
    for (const stream of data.result) {
      const values = stream?.values;
      if (!Array.isArray(values)) continue;
      for (const [ns, line] of values) {
        const ts = parseInt(String(ns).slice(0, 13), 10);
        const date = new Date(ts);
        const timeStr = Number.isFinite(date.getTime()) ? date.toISOString() : "";
        logs.push({ time: timeStr, line: String(line ?? "") });
      }
    }
  }

  return logs.sort((a, b) => a.time.localeCompare(b.time));
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!GRAFANA_URL) {
    return NextResponse.json(
      { error: "GRAFANA_URL not configured" },
      { status: 500 }
    );
  }

  let body: { interval?: string; from?: number | string; to?: number | string; query?: string; target?: string; cookie?: string; additionalFilter?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const useProvidedCookie = typeof body.cookie === "string" && body.cookie.trim().length > 0;

  const query = typeof body.query === "string" ? body.query : "";
  const target = typeof body.target === "string" ? body.target.trim() || "liveness-bot" : "liveness-bot";
  const additionalFilter = typeof body.additionalFilter === "string" ? body.additionalFilter.trim() : "";

  function parseTime(v: number | string | undefined): number | null {
    if (v == null) return null;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) return n;
      const d = Date.parse(v);
      return Number.isFinite(d) ? d : null;
    }
    return null;
  }

  let from: number;
  let to: number;
  const fromVal = parseTime(body.from);
  const toVal = parseTime(body.to);
  if (fromVal != null && toVal != null && fromVal < toVal) {
    from = fromVal;
    to = toVal;
  } else {
    const interval = body.interval ?? "6h";
    const intervalMs = INTERVAL_MS[interval] ?? INTERVAL_MS["6h"];
    to = Date.now();
    from = to - intervalMs;
  }
  const intervalMs = to - from;

  const base = GRAFANA_URL.replace(/\/$/, "");
  const loginUrl = `${base}/login`;

  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (compatible; Grafana-Logs-UI/1.0)",
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Referer": loginUrl,
  };

  let cookieHeader: string;

  if (useProvidedCookie) {
    cookieHeader = body.cookie!.trim();
  } else {
    const loginRes = await fetch(loginUrl, {
      method: "POST",
      headers,
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
    cookieHeader = getCookieHeader(setCookie);
    if (!cookieHeader) {
      const text = await loginRes.text();
      return NextResponse.json(
        { error: "Grafana login failed (no session cookie)", details: text.slice(0, 200) },
        { status: 502 }
      );
    }
  }

  let expr = query
    ? `{app="${target}"} |= \`${query.replace(/`/g, "\\`")}\``
    : `{app="${target}"}`;
  if (additionalFilter) {
    expr += ` |= \`${additionalFilter.replace(/`/g, "\\`")}\``;
  }

  const queryUrl = `${base}/api/ds/query?ds_type=loki&requestId=logs_1`;
  const queryHeaders: Record<string, string> = {
    ...headers,
    "Cookie": cookieHeader,
    "Origin": base,
    "x-datasource-uid": LOKI_DATASOURCE_UID,
    "x-grafana-org-id": "1",
    "x-plugin-id": "loki",
    "x-query-group-id": "logs-ui",
  };

  const queryBody = {
    queries: [
      {
        expr,
        queryType: "range",
        refId: "logs",
        maxLines: 500,
        datasource: { type: "loki", uid: LOKI_DATASOURCE_UID },
        datasourceId: 1,
        intervalMs: intervalMs,
      },
    ],
    from: String(from),
    to: String(to),
  };

  let raw: unknown = {};
  let queryRes: Response | null = null;
  let attempt = 0;

  for (;;) {
    queryRes = await fetch(queryUrl, {
      method: "POST",
      headers: queryHeaders,
      body: JSON.stringify(queryBody),
      // @ts-expect-error
      rejectUnauthorized: false,
    });
    raw = await queryRes.json().catch(() => ({}));
    const err = (raw as { results?: { logs?: { error?: string } } })?.results?.logs?.error;
    const isRateLimit = err && String(err).toLowerCase().includes("too many outstanding");
    if (!isRateLimit) break;
    const delayMs = Math.min(1000 * 2 ** attempt, 2000);
    await new Promise((r) => setTimeout(r, delayMs));
    attempt++;
  }

  const logs = parseLogsFromResponse(raw);
  return NextResponse.json({ logs, rawStatus: queryRes?.status ?? 0 });
}
