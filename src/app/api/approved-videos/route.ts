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

type LogEntry = { time: string; line: string };

/** vfs-global-bot correlation (in-house verification logs) */
const VFS_BOT_APP = "vfs-global-bot";
const AZURE_LIVENESS_BOT_APP = "azure-liveness-bot";

type SolveKind = "drop" | "verification";

type EmailTimelineEvent = {
  timeMs: number;
  email: string;
  kind: "solving" | "success" | "fail";
  failN?: number;
  failM?: number;
  submitN?: number;
  submitM?: number;
};

type ApplicantOutcome = {
  email: string;
  outcome: "success" | "failed" | "pending";
  successOnTry: 1 | 2 | 3 | null;
  /** Count of `In-house solver attempt failed` lines for this email (identity-failed cohort). */
  solverFailureCount?: number;
};

type FailureReasonSample = {
  email: string;
  passportNumber: string | null;
  videoLink: string | null;
};

type SolvingSnapshot = {
  timeMs: number;
  passportNumber: string | null;
  videoLink: string | null;
};

type TaskPayloadIatRow = {
  solvingTaskId: string;
  sessionPrefix: string;
  messageId: string | null;
  actualLogTime: string;
  iatTime: string | null;
  invalidToken: boolean;
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

  return logs.sort((a, b) => a.time.localeCompare(b.time));
}

function extractField(line: string, key: string): string | undefined {
  const r = new RegExp(`${key}=([^\\s,\\]]+)`, "i");
  const m = line.match(r);
  return m?.[1];
}

const FAILURE_REASON_MAX_LEN = 500;

function normalizeFailureReasonKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "(empty)";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return normalizeFailureReasonKey(trimmed.slice(1, -1));
  }
  const withoutTaskId = trimmed.replace(/\[TaskId=[^\]]+\]\s*/gi, "").trim();
  if (!withoutTaskId) return "(empty)";

  let normalized = withoutTaskId;
  const emailAt = normalized.search(/\s+email=/i);
  if (emailAt >= 0) normalized = normalized.slice(0, emailAt).trim();
  const trailingBracket = normalized.endsWith("]") ? normalized.slice(0, -1).trim() : normalized;
  const metaBracket = trailingBracket.search(/\s+\[/);
  if (metaBracket > 0) normalized = trailingBracket.slice(0, metaBracket).trim();
  else normalized = trailingBracket.trim();
  if (!normalized) return "(empty)";

  let rawNorm = normalized;
  const solverFailedMatch = rawNorm.match(/solver\s+failed:\s*(.+)$/i);
  if (solverFailedMatch?.[1]) {
    rawNorm = solverFailedMatch[1].trim();
  }
  if (/status\s+not\s+approved|status\s+not\s+approaved/i.test(rawNorm)) {
    return "status not approaved";
  }
  if (rawNorm.startsWith("{")) {
    try {
      const j = JSON.parse(rawNorm) as Record<string, unknown>;
      const le = j.livenessError != null ? String(j.livenessError) : "";
      const re = j.recognitionError != null ? String(j.recognitionError) : "";
      return `{livenessError:"${le}",recognitionError:"${re}"}`;
    } catch {
      return rawNorm.length > FAILURE_REASON_MAX_LEN
        ? `${rawNorm.slice(0, FAILURE_REASON_MAX_LEN - 3)}...`
        : rawNorm;
    }
  }
  return rawNorm.length > FAILURE_REASON_MAX_LEN
    ? `${rawNorm.slice(0, FAILURE_REASON_MAX_LEN - 3)}...`
    : rawNorm;
}

/** Returns one or more normalized failure reason keys (concurrent warning => multiple entries). */
function extractFailureReasonKeys(line: string): string[] {
  if (line.includes("In-house identity verification attempt failed")) {
    const m = line.match(/attempt failed\s*\(\d+\/\d+\):\s*(.+?)\s+email=/i);
    if (m?.[1]) return [normalizeFailureReasonKey(m[1])];
    const m2 = line.match(/attempt failed\s*\(\d+\/\d+\):\s*(.+)$/i);
    if (m2?.[1]) return [normalizeFailureReasonKey(m2[1])];
    return [];
  }

  if (isConcurrentAttemptsWarnFailure(line)) {
    const m = line.match(/Errors:\s*(.+?)\s+email=/i) ?? line.match(/Errors:\s*(.+)$/i);
    if (!m?.[1]) return ["In-house identity verification failed across 3 concurrent attempts"];
    return m[1]
      .split("|")
      .map((part) => normalizeFailureReasonKey(part))
      .filter((part) => part.length > 0);
  }

  return [];
}

function extractFailureReasonKey(line: string): string | null {
  if (isNewInHouseIdentityTerminalFailure(line)) {
    return "Identity verification not approved after in-house solves";
  }
  const keys = extractFailureReasonKeys(line);
  const raw = keys[0] ?? null;
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      const le = j.livenessError != null ? String(j.livenessError) : "";
      const re = j.recognitionError != null ? String(j.recognitionError) : "";
      return `{livenessError:"${le}",recognitionError:"${re}"}`;
    } catch {
      return raw.length > FAILURE_REASON_MAX_LEN ? `${raw.slice(0, FAILURE_REASON_MAX_LEN - 3)}...` : raw;
    }
  }

  return raw.length > FAILURE_REASON_MAX_LEN ? `${raw.slice(0, FAILURE_REASON_MAX_LEN - 3)}...` : raw;
}

function isInHouseSolverAttemptFailed(line: string): boolean {
  return /in-house solver attempt failed/i.test(line);
}

function isInHouseSolverAttemptSucceeded(line: string): boolean {
  return /in-house solver attempt succeeded/i.test(line);
}

/** Per email, ordered unique VideoLink values from solver success lines (cohort-filtered). */
function buildSolverSucceededVideosByEmail(
  solverLogs: LogEntry[],
  applicantEmails: Set<string>
): Map<string, string[]> {
  const sorted = [...solverLogs].sort((a, b) => a.time.localeCompare(b.time));
  const byEmail = new Map<string, string[]>();
  const seenPerEmail = new Map<string, Set<string>>();
  for (const e of sorted) {
    if (!isInHouseSolverAttemptSucceeded(e.line)) continue;
    const email = extractField(e.line, "email")?.toLowerCase();
    const video = extractField(e.line, "VideoLink");
    if (!email || !video || !applicantEmails.has(email)) continue;
    let seen = seenPerEmail.get(email);
    if (!seen) {
      seen = new Set();
      seenPerEmail.set(email, seen);
    }
    if (seen.has(video)) continue;
    seen.add(video);
    const arr = byEmail.get(email) ?? [];
    arr.push(video);
    byEmail.set(email, arr);
  }
  return byEmail;
}

function buildPassportByEmailFromVfsLogs(logs: LogEntry[]): Map<string, string | null> {
  const sorted = [...logs].sort((a, b) => a.time.localeCompare(b.time));
  const m = new Map<string, string | null>();
  for (const e of sorted) {
    const email = extractField(e.line, "email")?.toLowerCase();
    if (!email) continue;
    const p = extractField(e.line, "PassportNumber");
    if (p) m.set(email, p);
  }
  return m;
}

function lastFailureReasonForEmail(failLogs: LogEntry[], email: string): string {
  let best = "";
  let bestMs = -Infinity;
  for (const e of failLogs) {
    if (!isNotAcceptedStyleFailure(e.line)) continue;
    const em = extractField(e.line, "email")?.toLowerCase();
    if (em !== email) continue;
    const t = Date.parse(e.time);
    if (!Number.isFinite(t)) continue;
    if (t >= bestMs) {
      bestMs = t;
      best = extractFailureReasonKey(e.line) ?? "";
    }
  }
  return best;
}

/** Error text from `In-house solver attempt failed … Error=… email=` */
function extractSolverAttemptError(line: string): string | null {
  const m = line.match(/Error=(.+?)\s+email=/i);
  const raw = m?.[1]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function isConcurrentAttemptsWarnFailure(line: string): boolean {
  const lower = line.toLowerCase();
  const requiredPrefix =
    "in-house identity verification failed: in-house identity verification failed across 3 concurrent attempts";
  if (!lower.includes(requiredPrefix)) return false;

  // Exclude the extra error envelope variant.
  if (/\berror:\s*\[type\s*=\s*error\b/i.test(line)) return false;

  // Exclude the non-target warning variant.
  if (/failed to activate in-house identity verification token/i.test(line)) return false;

  return true;
}

/** New log shape: terminal failure in one line (e.g. not approved after in-house solves). */
function isNewInHouseIdentityTerminalFailure(line: string): boolean {
  if (!/in-house identity verification failed/i.test(line)) return false;
  if (/in-house identity verification attempt failed/i.test(line)) return false;
  if (isConcurrentAttemptsWarnFailure(line)) return false;
  if (/failed to activate in-house identity verification token/i.test(line)) return false;
  return /not approved after in-house solves/i.test(line);
}

function isInHouseIdentityCompletedLine(line: string): boolean {
  return /in-house identity verification completed\b/i.test(line);
}

/** vfs-global-bot prose: contains `status not approved` (e.g. Identity verification failed (status not approved)). */
function isNotAcceptedStyleFailure(line: string): boolean {
  if (isNewInHouseIdentityTerminalFailure(line)) return true;
  if (
    line.includes("In-house identity verification attempt failed") &&
    /status\s+not\s+approved|status\s+not\s+approaved/i.test(line)
  ) {
    return true;
  }
  if (
    isConcurrentAttemptsWarnFailure(line) &&
    /status\s+not\s+approved|status\s+not\s+approaved/i.test(line)
  ) {
    return true;
  }
  return false;
}

/** First segment of TaskId UUID, e.g. bab9ebd2-8f79-... → bab9ebd2 */
function taskIdToSessionPrefix(taskId: string): string {
  const first = taskId.split("-")[0]?.trim().toLowerCase() ?? "";
  return first;
}

/**
 * Parses e.g. [LIVENESS] Solving face verification for session bab9ebd2 (passport: N3543561)...
 * or (passport: VERIFICATION) for verification jobs.
 */
function parseAzureLivenessSolvingLine(line: string): { sessionPrefix: string; passport: string } | null {
  if (!line.includes("Solving face verification for session")) return null;
  const m = line.match(/for session\s+([a-f0-9]+)\s*\(\s*passport:\s*([^)]+?)\s*\)/i);
  if (!m?.[1] || !m[2]) return null;
  return { sessionPrefix: m[1].trim().toLowerCase(), passport: m[2].trim() };
}

function buildSessionSolveKindMap(azureLogs: LogEntry[]): Map<string, SolveKind> {
  const map = new Map<string, SolveKind>();
  for (const e of azureLogs) {
    const parsed = parseAzureLivenessSolvingLine(e.line);
    if (!parsed) continue;
    const kind: SolveKind =
      parsed.passport.toUpperCase() === "VERIFICATION" ? "verification" : "drop";
    map.set(parsed.sessionPrefix, kind);
  }
  return map;
}

function parseSuccessfulSolvesFraction(line: string): { n?: number; m?: number } {
  const m = line.match(/SuccessfulSolves\s*=\s*(\d+)\s*\/\s*(\d+)/i);
  const n = m?.[1] ? parseInt(m[1], 10) : NaN;
  const mm = m?.[2] ? parseInt(m[2], 10) : NaN;
  return {
    n: Number.isFinite(n) ? n : undefined,
    m: Number.isFinite(mm) ? mm : undefined,
  };
}

function classifyVfsVerificationLine(
  line: string
):
  | { kind: "solving" }
  | { kind: "success"; submitN?: number; submitM?: number }
  | { kind: "fail"; failN?: number; failM?: number }
  | null {
  if (line.includes("Solving in-house identity verification")) return { kind: "solving" };
  if (isInHouseIdentityCompletedLine(line)) {
    const m = line.match(/SubmitAttempt\s*=\s*(\d+)\s*\/\s*(\d+)/i);
    const submitN = m?.[1] ? parseInt(m[1], 10) : NaN;
    const submitM = m?.[2] ? parseInt(m[2], 10) : NaN;
    if (Number.isFinite(submitN) && Number.isFinite(submitM)) {
      return { kind: "success", submitN, submitM };
    }
    const ss = parseSuccessfulSolvesFraction(line);
    if (ss.n != null && ss.m != null && ss.m > 0) {
      return { kind: "success", submitN: ss.n, submitM: ss.m };
    }
    return { kind: "success" };
  }
  if (line.includes("Identity verification completed successfully")) {
    const m = line.match(/SubmitAttempt\s*=\s*(\d+)\s*\/\s*(\d+)/i);
    const submitN = m?.[1] ? parseInt(m[1], 10) : NaN;
    const submitM = m?.[2] ? parseInt(m[2], 10) : NaN;
    return {
      kind: "success",
      submitN: Number.isFinite(submitN) ? submitN : undefined,
      submitM: Number.isFinite(submitM) ? submitM : undefined,
    };
  }
  if (isNewInHouseIdentityTerminalFailure(line)) {
    return { kind: "fail", failN: 1, failM: 1 };
  }
  if (isConcurrentAttemptsWarnFailure(line)) {
    return { kind: "fail", failN: 3, failM: 3 };
  }
  if (line.includes("In-house identity verification attempt failed")) {
    const m = line.match(/attempt failed\s*\((\d+)\/(\d+)\)/i);
    const failN = m?.[1] ? parseInt(m[1], 10) : NaN;
    const failM = m?.[2] ? parseInt(m[2], 10) : NaN;
    return {
      kind: "fail",
      failN: Number.isFinite(failN) ? failN : undefined,
      failM: Number.isFinite(failM) ? failM : undefined,
    };
  }
  return null;
}

function logEntryToEmailTimeline(e: LogEntry): EmailTimelineEvent | null {
  const cls = classifyVfsVerificationLine(e.line);
  if (!cls) return null;
  const timeMs = Date.parse(e.time);
  if (!Number.isFinite(timeMs)) return null;
  const email = extractField(e.line, "email");
  if (!email) return null;
  const base = { timeMs, email: email.toLowerCase(), kind: cls.kind } as const;
  if (cls.kind === "fail") {
    return { ...base, kind: "fail", failN: cls.failN, failM: cls.failM };
  }
  if (cls.kind === "success") {
    return { ...base, kind: "success", submitN: cls.submitN, submitM: cls.submitM };
  }
  return { ...base, kind: cls.kind };
}

function mergeEmailTimelines(logStreams: LogEntry[][]): Map<string, EmailTimelineEvent[]> {
  const byEmail = new Map<string, EmailTimelineEvent[]>();
  for (const logs of logStreams) {
    for (const entry of logs) {
      const ev = logEntryToEmailTimeline(entry);
      if (!ev) continue;
      const arr = byEmail.get(ev.email) ?? [];
      arr.push(ev);
      byEmail.set(ev.email, arr);
    }
  }
  for (const arr of byEmail.values()) {
    arr.sort((a, b) => a.timeMs - b.timeMs || a.kind.localeCompare(b.kind));
  }
  return byEmail;
}

function deriveApplicantOutcome(email: string, eventsAll: EmailTimelineEvent[]): ApplicantOutcome {
  const firstSolvingIdx = eventsAll.findIndex((e) => e.kind === "solving");
  const events = firstSolvingIdx < 0 ? [] : eventsAll.slice(firstSolvingIdx);

  let outcome: ApplicantOutcome["outcome"] = "pending";
  let successOnTry: ApplicantOutcome["successOnTry"] = null;
  /** Legacy fallback only (older logs without `SubmitAttempt=` on success lines). */
  let inHouseFailCountSinceLastSuccess = 0;

  for (const e of events) {
    if (e.kind === "solving") {
      outcome = "pending";
      successOnTry = null;
      continue;
    }
    if (e.kind === "fail") {
      inHouseFailCountSinceLastSuccess += 1;
      const n = e.failN;
      const m = e.failM;
      const terminal =
        (n === 3 && m === 3) || (n === 1 && m === 1);
      if (terminal) {
        outcome = "failed";
        successOnTry = null;
        inHouseFailCountSinceLastSuccess = 0;
      }
      continue;
    }
    if (e.kind === "success") {
      outcome = "success";
      const submitTry = e.submitN;
      const tryNum = Number.isFinite(submitTry as number)
        ? (Math.min(3, Math.max(1, submitTry as number)) as 1 | 2 | 3)
        : (Math.min(3, Math.max(1, inHouseFailCountSinceLastSuccess + 1)) as 1 | 2 | 3);
      successOnTry = tryNum;
      inHouseFailCountSinceLastSuccess = 0;
    }
  }

  return { email, outcome, successOnTry };
}

function pickRandomItems<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, count);
}

function buildSolvingSnapshotsByEmail(solvingLogs: LogEntry[]): Map<string, SolvingSnapshot[]> {
  const byEmail = new Map<string, SolvingSnapshot[]>();
  for (const entry of solvingLogs) {
    const email = extractField(entry.line, "email")?.toLowerCase();
    if (!email) continue;
    const timeMs = Date.parse(entry.time);
    if (!Number.isFinite(timeMs)) continue;
    const arr = byEmail.get(email) ?? [];
    arr.push({
      timeMs,
      passportNumber: extractField(entry.line, "PassportNumber") ?? null,
      videoLink: extractField(entry.line, "VideoLink") ?? null,
    });
    byEmail.set(email, arr);
  }
  for (const arr of byEmail.values()) arr.sort((a, b) => a.timeMs - b.timeMs);
  return byEmail;
}

function pickSnapshotForFailure(
  snapshotsByEmail: Map<string, SolvingSnapshot[]>,
  email: string,
  failureTimeMs: number
): SolvingSnapshot | null {
  const arr = snapshotsByEmail.get(email) ?? [];
  if (arr.length === 0) return null;
  let chosen = arr[0];
  for (const s of arr) {
    if (s.timeMs <= failureTimeMs) chosen = s;
    else break;
  }
  return chosen;
}

function decodeJwtPayload(credentials: string): Record<string, unknown> | null {
  const parts = credentials.split(".");
  if (parts.length < 2) return null;
  try {
    const base64url = parts[1];
    const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parsePayloadIatRowsByPrefix(
  sessionPrefixes: Set<string>,
  logs: LogEntry[]
): Map<string, Omit<TaskPayloadIatRow, "solvingTaskId" | "invalidToken">[]> {
  const byPrefix = new Map<string, Omit<TaskPayloadIatRow, "solvingTaskId" | "invalidToken">[]>();
  for (const entry of logs) {
    const line = entry.line;
    if (!line.includes("[REDIS][PAYLOAD]")) continue;
    const payloadMatch = line.match(/payload=(\{.+\})\s*$/);
    if (!payloadMatch?.[1]) continue;
    try {
      const payload = JSON.parse(payloadMatch[1]) as Record<string, unknown>;
      const credentials = typeof payload.credentials === "string" ? payload.credentials : "";
      if (!credentials) continue;
      const jwt = decodeJwtPayload(credentials);
      const iatSecRaw = jwt?.iat;
      const iatSec =
        typeof iatSecRaw === "number" && Number.isFinite(iatSecRaw)
          ? iatSecRaw
          : typeof iatSecRaw === "string" && /^\d+$/.test(iatSecRaw)
            ? parseInt(iatSecRaw, 10)
            : NaN;
      const iatTime = Number.isFinite(iatSec) ? new Date(iatSec * 1000).toISOString() : null;
      const payloadSessionId =
        typeof payload.sessionId === "string" && payload.sessionId.trim()
          ? payload.sessionId.trim()
          : typeof payload.id === "string" && payload.id.trim()
            ? payload.id.trim()
            : "";
      if (!payloadSessionId) continue;
      const sessionPrefix = taskIdToSessionPrefix(payloadSessionId);
      if (!sessionPrefix || !sessionPrefixes.has(sessionPrefix)) continue;
      const arr = byPrefix.get(sessionPrefix) ?? [];
      arr.push({
        sessionPrefix,
        messageId: extractField(line, "message_id") ?? null,
        actualLogTime: entry.time,
        iatTime,
      });
      byPrefix.set(sessionPrefix, arr);
    } catch {
      continue;
    }
  }
  for (const arr of byPrefix.values()) {
    arr.sort((a, b) => a.actualLogTime.localeCompare(b.actualLogTime));
  }
  return byPrefix;
}

/** Trailing JSON on `[RESULT] FAILED: session … — {...}` lines */
function parseAzureResultFailedPayload(line: string): Record<string, unknown> | null {
  const brace = line.lastIndexOf("{");
  if (brace < 0) return null;
  try {
    const j = JSON.parse(line.slice(brace)) as Record<string, unknown>;
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/** Session prefixes (first UUID segment) that logged InvalidToken in azure-liveness-bot for this window */
function buildInvalidTokenPrefixSet(logs: LogEntry[], relevantPrefixes: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const entry of logs) {
    const line = entry.line;
    if (!line.includes("[RESULT] FAILED")) continue;
    const payload = parseAzureResultFailedPayload(line);
    if (!payload || String(payload.livenessError) !== "InvalidToken") continue;
    const jobM = line.match(/\[JOB_ID:([a-f0-9-]+)\]/i);
    const sessionM = line.match(/session\s+([a-f0-9-]+)/i);
    const raw = (jobM?.[1] ?? sessionM?.[1] ?? "").trim();
    if (!raw) continue;
    const prefix = taskIdToSessionPrefix(raw);
    if (prefix && relevantPrefixes.has(prefix)) out.add(prefix);
  }
  return out;
}

async function loginCookie(base: string): Promise<string> {
  const loginUrl = `${base}/login`;
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (compatible; Approved-Videos-UI/1.0)",
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Referer": loginUrl,
  };
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
  return getCookieHeader(setCookie);
}

async function queryLogs(params: {
  base: string;
  cookieHeader: string;
  from: number;
  to: number;
  target: string;
  query: string;
  requestId?: string;
}): Promise<LogEntry[]> {
  const { base, cookieHeader, from, to, target, query, requestId = "approved_videos_1" } = params;
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (compatible; Approved-Videos-UI/1.0)",
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Cookie": cookieHeader,
    "Origin": base,
    "Referer": `${base}/login`,
    "x-datasource-uid": LOKI_DATASOURCE_UID,
    "x-grafana-org-id": "1",
    "x-plugin-id": "loki",
    "x-query-group-id": "approved-videos-ui",
  };
  const expr = `{app="${target}"} |= \`${query.replace(/`/g, "\\`")}\``;
  const queryBody = {
    queries: [
      {
        expr,
        queryType: "range",
        refId: "logs",
        maxLines: 5000,
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
    headers,
    body: JSON.stringify(queryBody),
    // @ts-expect-error Node fetch may accept this for self-signed
    rejectUnauthorized: false,
  });
  const raw = await res.json().catch(() => ({}));
  return parseLogsFromResponse(raw);
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!GRAFANA_URL) {
    return NextResponse.json({ error: "GRAFANA_URL not configured" }, { status: 500 });
  }

  let body: {
    interval?: string;
    from?: number | string;
    to?: number | string;
    target?: string;
    solveKind?: string;
    includeVideoSessionRows?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const solveKind: SolveKind =
    body.solveKind === "verification" || body.solveKind === "drop" ? body.solveKind : "drop";

  const target = typeof body.target === "string" && body.target.trim() ? body.target.trim() : "vfs-global-bot";
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
    const interval = body.interval ?? "24h";
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["24h"];
    to = Date.now();
    from = to - ms;
  }
  const base = GRAFANA_URL.replace(/\/$/, "");
  const cookieHeader = await loginCookie(base);

  if (!cookieHeader) {
    return NextResponse.json({ error: "Grafana login failed (no session cookie)" }, { status: 502 });
  }

  const [
    solvingLogsAll,
    identityAllLogs,
    legacySuccessLogs,
    solverLogsAll,
    azureLivenessLogs,
    azurePayloadLogs,
    azureResultFailedLogs,
  ] =
    await Promise.all([
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      target: VFS_BOT_APP,
      query: "Solving in-house identity verification",
      requestId: "approved_vfs_solving",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      target: VFS_BOT_APP,
      query: "In-house identity",
      requestId: "approved_vfs_identity",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      target: VFS_BOT_APP,
      query: "Identity verification completed successfully",
      requestId: "approved_vfs_success",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      target: VFS_BOT_APP,
      query: "In-house solver",
      requestId: "approved_vfs_solver",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      target: AZURE_LIVENESS_BOT_APP,
      query: "Solving face verification for session",
      requestId: "approved_azure_liveness",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      target: AZURE_LIVENESS_BOT_APP,
      query: "[REDIS][PAYLOAD]",
      requestId: "approved_azure_payload",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      target: AZURE_LIVENESS_BOT_APP,
      query: "[RESULT] FAILED",
      requestId: "approved_azure_result_failed",
    }),
  ]);

  const identityOutcomeLogs = identityAllLogs.filter(
    (entry) => !entry.line.includes("Solving in-house identity verification")
  );
  const identitySuccessLogs = identityOutcomeLogs.filter((entry) =>
    isInHouseIdentityCompletedLine(entry.line)
  );
  const successLogs = [...legacySuccessLogs, ...identitySuccessLogs].sort((a, b) =>
    a.time.localeCompare(b.time)
  );
  const identityFailLogs = identityOutcomeLogs.filter((entry) => {
    const c = classifyVfsVerificationLine(entry.line);
    return c?.kind === "fail";
  });
  const failLogs = identityFailLogs;

  const sessionSolveKind = buildSessionSolveKindMap(azureLivenessLogs);

  let solvingNoTaskId = 0;
  let solvingNoAzureMatch = 0;
  let solvingWrongKind = 0;
  const solvingLogs = solvingLogsAll.filter((entry) => {
    const taskId = extractField(entry.line, "TaskId");
    if (!taskId) {
      solvingNoTaskId += 1;
      return false;
    }
    const prefix = taskIdToSessionPrefix(taskId);
    if (!prefix) {
      solvingNoTaskId += 1;
      return false;
    }
    const mapped = sessionSolveKind.get(prefix);
    if (mapped == null) {
      solvingNoAzureMatch += 1;
      return false;
    }
    if (mapped !== solveKind) {
      solvingWrongKind += 1;
      return false;
    }
    return true;
  });

  const timelinesByEmail = mergeEmailTimelines([solvingLogs, successLogs, failLogs]);
  const applicantEmails = new Set<string>();
  for (const entry of solvingLogs) {
    const ev = logEntryToEmailTimeline(entry);
    if (ev?.kind === "solving") applicantEmails.add(ev.email);
  }

  const solverFailCountByEmail = new Map<string, number>();
  for (const entry of solverLogsAll) {
    if (!isInHouseSolverAttemptFailed(entry.line)) continue;
    const email = extractField(entry.line, "email")?.toLowerCase();
    if (!email || !applicantEmails.has(email)) continue;
    solverFailCountByEmail.set(email, (solverFailCountByEmail.get(email) ?? 0) + 1);
  }

  const applicantOutcomes: ApplicantOutcome[] = [...applicantEmails]
    .sort()
    .map((email) => deriveApplicantOutcome(email, timelinesByEmail.get(email) ?? []))
    .map((o) =>
      o.outcome === "failed"
        ? { ...o, solverFailureCount: solverFailCountByEmail.get(o.email) ?? 0 }
        : o
    );

  let successCount = 0;
  let failureCount = 0;
  let pendingCount = 0;
  let solvedOnFirstTry = 0;
  let solvedOnSecondTry = 0;
  let solvedOnThirdTry = 0;

  for (const o of applicantOutcomes) {
    if (o.outcome === "success") {
      successCount += 1;
      if (o.successOnTry === 1) solvedOnFirstTry += 1;
      else if (o.successOnTry === 2) solvedOnSecondTry += 1;
      else if (o.successOnTry === 3) solvedOnThirdTry += 1;
    } else if (o.outcome === "failed") failureCount += 1;
    else pendingCount += 1;
  }

  const failedEmailSet = new Set(
    applicantOutcomes.filter((o) => o.outcome === "failed").map((o) => o.email)
  );
  let terminalFailureLogCount = 0;
  for (const o of applicantOutcomes) {
    if (o.outcome === "failed") terminalFailureLogCount += o.solverFailureCount ?? 0;
  }

  const failureReasonCounts = new Map<string, number>();
  const failureReasonSamples = new Map<string, FailureReasonSample[]>();
  const solvingSnapshotsByEmail = buildSolvingSnapshotsByEmail(solvingLogs);
  for (const entry of solverLogsAll) {
    if (!isInHouseSolverAttemptFailed(entry.line)) continue;
    const email = extractField(entry.line, "email")?.toLowerCase();
    if (!email || !failedEmailSet.has(email)) continue;
    const errRaw = extractSolverAttemptError(entry.line);
    const reasonKey = errRaw ? normalizeFailureReasonKey(errRaw) : "(no Error= field)";
    const failureTimeMs = Date.parse(entry.time);
    const solvingSnap = Number.isFinite(failureTimeMs)
      ? pickSnapshotForFailure(solvingSnapshotsByEmail, email, failureTimeMs)
      : null;
    const passportFromLine = extractField(entry.line, "PassportNumber");
    const videoFromLine = extractField(entry.line, "VideoLink");
    const sample: FailureReasonSample = {
      email,
      passportNumber: passportFromLine ?? solvingSnap?.passportNumber ?? null,
      videoLink: videoFromLine ?? solvingSnap?.videoLink ?? null,
    };
    failureReasonCounts.set(reasonKey, (failureReasonCounts.get(reasonKey) ?? 0) + 1);
    const arr = failureReasonSamples.get(reasonKey) ?? [];
    arr.push(sample);
    failureReasonSamples.set(reasonKey, arr);
  }

  const failureReasonBreakdown = [...failureReasonCounts.entries()]
    .map(([reason, count]) => {
      const candidates = failureReasonSamples.get(reason) ?? [];
      const unique = new Map<string, FailureReasonSample>();
      for (const s of candidates) {
        const key = `${s.email}|${s.passportNumber ?? ""}|${s.videoLink ?? ""}`;
        if (!unique.has(key)) unique.set(key, s);
      }
      return {
        reason,
        count,
        samples: pickRandomItems([...unique.values()], 3),
      };
    })
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const solvingTaskIds = [...new Set(solvingLogs.map((e) => extractField(e.line, "TaskId") ?? "").filter(Boolean))];
  const solvingPrefixes = new Set(
    solvingTaskIds.map((id) => taskIdToSessionPrefix(id)).filter((p) => p.length > 0)
  );
  const payloadRowsByPrefix = parsePayloadIatRowsByPrefix(solvingPrefixes, azurePayloadLogs);
  const invalidTokenPrefixes = buildInvalidTokenPrefixSet(azureResultFailedLogs, solvingPrefixes);
  const taskPayloadIatRows: TaskPayloadIatRow[] = [];
  for (const taskId of solvingTaskIds) {
    const prefix = taskIdToSessionPrefix(taskId);
    if (!prefix) continue;
    const matched = payloadRowsByPrefix.get(prefix) ?? [];
    const invalidToken = invalidTokenPrefixes.has(prefix);
    for (const row of matched) {
      taskPayloadIatRows.push({ solvingTaskId: taskId, ...row, invalidToken });
    }
  }
  taskPayloadIatRows.sort((a, b) => a.actualLogTime.localeCompare(b.actualLogTime));

  type VideoSessionRow = { email: string; videoLinks: string[]; passportNumber: string | null };
  type VideoSessionNotAcceptedRow = VideoSessionRow & { failureReason: string };

  let sessionVideoApprovedRows: VideoSessionRow[] | undefined;
  let sessionVideoNotAcceptedRows: VideoSessionNotAcceptedRow[] | undefined;

  if (body.includeVideoSessionRows === true) {
    const passportByEmail = buildPassportByEmailFromVfsLogs([
      ...identityOutcomeLogs,
      ...legacySuccessLogs,
      ...failLogs,
    ]);
    const solverOkVideosByEmail = buildSolverSucceededVideosByEmail(solverLogsAll, applicantEmails);

    sessionVideoApprovedRows = [];
    for (const o of applicantOutcomes) {
      if (o.outcome !== "success") continue;
      const videoLinks = solverOkVideosByEmail.get(o.email) ?? [];
      if (videoLinks.length === 0) continue;
      sessionVideoApprovedRows.push({
        email: o.email,
        videoLinks,
        passportNumber: passportByEmail.get(o.email) ?? null,
      });
    }

    sessionVideoNotAcceptedRows = [];
    for (const o of applicantOutcomes) {
      if (o.outcome !== "failed") continue;
      const videoLinks = solverOkVideosByEmail.get(o.email) ?? [];
      if (videoLinks.length === 0) continue;
      sessionVideoNotAcceptedRows.push({
        email: o.email,
        videoLinks,
        passportNumber: passportByEmail.get(o.email) ?? null,
        failureReason: lastFailureReasonForEmail(failLogs, o.email),
      });
    }
  }

  return NextResponse.json({
    from,
    to,
    target,
    solveKind,
    vfsCorrelationApp: VFS_BOT_APP,
    azureCorrelationApp: AZURE_LIVENESS_BOT_APP,
    totals: {
      applicantCount: applicantEmails.size,
      successCount,
      failureCount,
      terminalFailureLogCount,
      pendingCount,
      solvedOnFirstTry,
      solvedOnSecondTry,
      solvedOnThirdTry,
      solvingLogLines: solvingLogs.length,
      solvingLogLinesRaw: solvingLogsAll.length,
      successLogLines: successLogs.length,
      failLogLines: failLogs.length,
      identityVerificationLogLines: identityAllLogs.length,
      identityOutcomeLogLines: identityOutcomeLogs.length,
      solverLogLines: solverLogsAll.length,
      azureLivenessLogLines: azureLivenessLogs.length,
      azureSessionPrefixesMapped: sessionSolveKind.size,
      solvingExcludedNoTaskId: solvingNoTaskId,
      solvingExcludedNoAzureMatch: solvingNoAzureMatch,
      solvingExcludedWrongKind: solvingWrongKind,
      azurePayloadLogLines: azurePayloadLogs.length,
      azureResultFailedLogLines: azureResultFailedLogs.length,
      taskPayloadRows: taskPayloadIatRows.length,
      azureInvalidTokenJobCount: invalidTokenPrefixes.size,
    },
    applicantOutcomes,
    failureReasonBreakdown,
    taskPayloadIatRows,
    ...(sessionVideoApprovedRows != null && sessionVideoNotAcceptedRows != null
      ? { sessionVideoApprovedRows, sessionVideoNotAcceptedRows }
      : {}),
  });
}

