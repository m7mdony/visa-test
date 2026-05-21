import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

const GRAFANA_URL = process.env.GRAFANA_URL ?? "";
const GRAFANA_USER = process.env.GRAFANA_USER ?? "admin";
const GRAFANA_PASSWORD = process.env.GRAFANA_PASSWORD ?? "";
const LOKI_DATASOURCE_UID = process.env.LOKI_DATASOURCE_UID ?? "P8E80F9AEF21F6940";
const VFS_APP = "vfs-global-bot";

type LogEntry = { time: string; line: string };
type ExtractRow = {
  email: string;
  passportNumber: string | null;
};

function getCookieHeader(setCookie: string[]): string {
  return setCookie
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function parseLogsFromResponse(body: unknown): LogEntry[] {
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
          const d = new Date(ts);
          if (!Number.isFinite(d.getTime())) continue;
          logs.push({ time: d.toISOString(), line: String(lines[i] ?? "") });
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
        logs.push({ time: d.toISOString(), line: String(line ?? "") });
      }
    }
  }

  logs.sort((a, b) => a.time.localeCompare(b.time));
  return logs;
}

function extractEmails(text: string): string[] {
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  return [...new Set(matches.map((v) => v.toLowerCase()))];
}

function extractTimes(text: string): number[] {
  const out: number[] = [];
  const regex = /\b(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\b/g;
  for (const m of text.matchAll(regex)) {
    const asIso = `${m[1]}T${m[2]}`;
    const ts = Date.parse(asIso);
    if (Number.isFinite(ts)) out.push(ts);
  }
  return out;
}

function extractPassportFromLine(line: string): string | null {
  const patterns = [
    /\bPassportNumber=([^\s,}\]]+)/i,
    /\bpassportNumber=([^\s,}\]]+)/i,
    /\bpassport=([^\s,}\]]+)/i,
    /"passportNumber"\s*:\s*"([^"]+)"/i,
    /"passport"\s*:\s*"([^"]+)"/i,
    /\[passport=([^\]]+)\]/i,
  ];
  for (const re of patterns) {
    const m = line.match(re);
    if (m?.[1]) {
      const v = m[1].trim().replace(/^["']|["']$/g, "");
      if (v) return v;
    }
  }
  return null;
}

async function loginCookie(base: string): Promise<string> {
  const loginUrl = `${base}/login`;
  const loginRes = await fetch(loginUrl, {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Passport-Extractor-UI/1.0)",
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

async function queryLogs(params: {
  base: string;
  cookieHeader: string;
  from: number;
  to: number;
  query: string;
  requestId: string;
}): Promise<LogEntry[]> {
  const { base, cookieHeader, from, to, query, requestId } = params;
  const queryBody = {
    queries: [
      {
        expr: `{app="${VFS_APP}"} |= \`${query.replace(/`/g, "\\`")}\``,
        queryType: "range",
        refId: "logs",
        maxLines: 1200,
        datasource: { type: "loki", uid: LOKI_DATASOURCE_UID },
        datasourceId: 1,
        intervalMs: to - from,
      },
    ],
    from: String(from),
    to: String(to),
  };
  const res = await fetch(`${base}/api/ds/query?ds_type=loki&requestId=${encodeURIComponent(requestId)}`, {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Passport-Extractor-UI/1.0)",
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      Origin: base,
      "x-datasource-uid": LOKI_DATASOURCE_UID,
      "x-grafana-org-id": "1",
      "x-plugin-id": "loki",
      "x-query-group-id": "passport-extractor-ui",
    },
    body: JSON.stringify(queryBody),
    // @ts-expect-error Node fetch may accept this for self-signed
    rejectUnauthorized: false,
  });
  const raw = await res.json().catch(() => ({}));
  return parseLogsFromResponse(raw);
}

function bestPassportForEmail(email: string, logs: LogEntry[]): ExtractRow {
  let chosen: ExtractRow = {
    email,
    passportNumber: null,
  };
  for (const entry of logs) {
    if (!entry.line.toLowerCase().includes(email)) continue;
    const passport = extractPassportFromLine(entry.line);
    if (!passport) continue;
    chosen = {
      email,
      passportNumber: passport,
    };
  }
  return chosen;
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!GRAFANA_URL) {
    return NextResponse.json({ error: "GRAFANA_URL not configured" }, { status: 500 });
  }

  let body: { logsText?: unknown; from?: unknown; to?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const logsText = typeof body.logsText === "string" ? body.logsText : "";
  if (!logsText.trim()) {
    return NextResponse.json({ error: "logsText is required" }, { status: 400 });
  }
  function parseTime(v: unknown): number | null {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) return n;
      const d = Date.parse(v);
      return Number.isFinite(d) ? d : null;
    }
    return null;
  }

  const emails = extractEmails(logsText).slice(0, 120);
  if (emails.length === 0) {
    return NextResponse.json({ error: "No emails found in input logs" }, { status: 400 });
  }

  const parsedTimes = extractTimes(logsText);
  const now = Date.now();
  const bodyFrom = parseTime(body.from);
  const bodyTo = parseTime(body.to);
  const minTs = parsedTimes.length > 0 ? Math.min(...parsedTimes) : now - 24 * 60 * 60 * 1000;
  const maxTs = parsedTimes.length > 0 ? Math.max(...parsedTimes) : now;
  const autoFrom = minTs - 2 * 60 * 60 * 1000;
  const autoTo = maxTs + 2 * 60 * 60 * 1000;
  const from = bodyFrom != null ? bodyFrom : autoFrom;
  const to = bodyTo != null ? bodyTo : autoTo;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return NextResponse.json({ error: "Invalid search range: From must be before To" }, { status: 400 });
  }

  const base = GRAFANA_URL.replace(/\/$/, "");
  const cookieHeader = await loginCookie(base);
  if (!cookieHeader) {
    return NextResponse.json({ error: "Grafana login failed (no session cookie)" }, { status: 502 });
  }

  const errors: string[] = [];
  const rows: ExtractRow[] = [];

  for (const email of emails) {
    try {
      const byEmailQuery = `email=${email}`;
      const logs = await queryLogs({
        base,
        cookieHeader,
        from,
        to,
        query: byEmailQuery,
        requestId: `passport_extract_${email.replace(/[^a-z0-9]/gi, "_")}`,
      });
      rows.push(bestPassportForEmail(email, logs));
    } catch (e: unknown) {
      rows.push({ email, passportNumber: null });
      errors.push(`${email}: ${e instanceof Error ? e.message : "query failed"}`);
    }
  }

  return NextResponse.json({
    emailsFromInput: emails,
    searchedFrom: from,
    searchedTo: to,
    rows,
    errors: errors.length > 0 ? errors : undefined,
  });
}
