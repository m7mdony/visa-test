import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  getGrafanaBase,
  isGrafanaConfigured,
  loginGrafanaCookie,
  queryVfsGlobalBotLogs,
  type LogEntry,
} from "@/lib/grafanaLoki";

export const maxDuration = 300;

const DAY_MS = 24 * 60 * 60 * 1000;
const UPLOAD_RESPONSE_FILTER = "/UploadApplicantDocument] Response:";

function parseTime(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== "") return n;
    const d = Date.parse(v);
    return Number.isFinite(d) ? d : null;
  }
  return null;
}

function extractEmail(line: string): string | null {
  const loginUser = line.match(/"loginUser"\s*:\s*"([^"]+)"/i);
  if (loginUser?.[1]?.includes("@")) return loginUser[1].trim().toLowerCase();
  const emailEq = line.match(/\bemail=([^\s,\]}"']+)/i);
  if (emailEq?.[1]?.includes("@")) return emailEq[1].trim().toLowerCase().replace(/[>"']+$/, "");
  const generic = line.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return generic?.[0]?.trim().toLowerCase() ?? null;
}

function logKey(entry: LogEntry): string {
  return `${entry.time}\n${entry.line}`;
}

function mergeLogs(existing: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  const seen = new Set(existing.map(logKey));
  const out = [...existing];
  for (const entry of incoming) {
    const k = logKey(entry);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(entry);
  }
  out.sort((a, b) => a.time.localeCompare(b.time));
  return out;
}

function pickEmails(logs: LogEntry[], limit: number): Array<{
  email: string;
  maxUploadTime: string;
  line: string;
}> {
  const out: Array<{ email: string; maxUploadTime: string; line: string }> = [];
  const seen = new Set<string>();
  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i];
    const email = extractEmail(entry.line);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, maxUploadTime: entry.time, line: entry.line });
    if (out.length >= limit) break;
  }
  return out;
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isGrafanaConfigured()) {
    return NextResponse.json({ error: "GRAFANA_URL not configured" }, { status: 500 });
  }

  let body: {
    mode?: unknown;
    maxFrom?: unknown;
    maxTo?: unknown;
    docsFrom?: unknown;
    docsTo?: unknown;
    emailCount?: unknown;
    email?: unknown;
    logTime?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const mode = body.mode === "docs" ? "docs" : "emails";
  const base = getGrafanaBase();
  const cookieHeader = await loginGrafanaCookie(base);
  if (!cookieHeader) {
    return NextResponse.json({ error: "Grafana login failed (no session cookie)" }, { status: 502 });
  }

  if (mode === "emails") {
    const maxFrom = parseTime(body.maxFrom);
    const maxTo = parseTime(body.maxTo);
    const emailCount = Math.min(50, Math.max(1, Math.floor(Number(body.emailCount) || 1)));
    if (maxFrom == null || maxTo == null || maxFrom >= maxTo) {
      return NextResponse.json({ error: "Max upload From must be before To." }, { status: 400 });
    }
    const logs = await queryVfsGlobalBotLogs({
      base,
      cookieHeader,
      from: maxFrom,
      to: maxTo,
      query: "Max upload",
      requestId: "max-upload-emails",
    });
    return NextResponse.json({
      emails: pickEmails(logs, emailCount),
      matchedLogs: logs.length,
    });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Valid email required." }, { status: 400 });
  }
  const docsFrom = parseTime(body.docsFrom);
  const docsTo = parseTime(body.docsTo);
  const logTime = parseTime(body.logTime);
  if (docsFrom == null || docsTo == null || docsFrom >= docsTo) {
    return NextResponse.json({ error: "Upload documents From must be before To." }, { status: 400 });
  }
  if (logTime == null) {
    return NextResponse.json({ error: "Max upload log time required." }, { status: 400 });
  }

  const windowEnd = Math.min(logTime, docsTo);
  const windowStart = docsFrom;
  if (windowStart >= windowEnd) {
    return NextResponse.json({
      email,
      logs: [],
      chunks: 0,
      skipped: true,
      reason: "Max upload log time is not after the documents From date.",
    });
  }

  let stacked: LogEntry[] = [];
  let chunks = 0;
  let end = windowEnd;
  while (end > windowStart) {
    const start = Math.max(windowStart, end - DAY_MS);
    if (start >= end) break;
    const chunkLogs = await queryVfsGlobalBotLogs({
      base,
      cookieHeader,
      from: start,
      to: end,
      query: [email, UPLOAD_RESPONSE_FILTER],
      requestId: `max-upload-docs-${chunks + 1}`,
    });
    stacked = mergeLogs(stacked, chunkLogs);
    chunks += 1;
    end = start;
  }

  return NextResponse.json({
    email,
    logs: stacked,
    chunks,
    skipped: false,
    from: windowStart,
    to: windowEnd,
  });
}
