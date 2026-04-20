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
const AZURE_LIVENESS_BOT_APP_PROD = "azure-liveness-bot";
/** Staging Azure worker app label in Loki (per ops/grafana). */
const AZURE_LIVENESS_BOT_APP_STAGING = "azure-liveness-automation-staging";
const LOKI_STAGING_NAMESPACE = "staging";

type DeploymentEnv = "prod" | "staging";

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
  /** Identity session id from `Activated … [ReferenceNumber: …]` (same as former TaskId for Azure). */
  referenceNumber?: string;
  outcome: "success" | "failed" | "pending";
  successOnTry: 1 | 2 | 3 | null;
  /** Failed attempt lines (`Attempt … failed` / legacy solver) attributed to this session (by `urn`). */
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

function dedupeLogEntries(entries: LogEntry[]): LogEntry[] {
  const seen = new Set<string>();
  const out: LogEntry[] = [];
  for (const e of entries) {
    const k = `${e.time}\0${e.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  out.sort((a, b) => a.time.localeCompare(b.time));
  return out;
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
  if (/Attempt\s+\d+\/\d+\s*:\s*failed/i.test(line)) {
    const dash = line.match(/Attempt\s+\d+\/\d+\s*:\s*failed\s*\([^)]*\)\s*-\s*(.+)$/i);
    const payload = dash?.[1]?.trim();
    if (payload) return [normalizeFailureReasonKey(payload)];
    return [];
  }
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
    const inner = line.match(/in-house verification failed\s*(\[[^\]]+\])/i);
    if (inner?.[1]) {
      return normalizeFailureReasonKey(`In-house verification failed ${inner[1]}`);
    }
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
  if (/in-house solver attempt failed/i.test(line)) return true;
  /** New shape: `Attempt 3/3: failed (8859ms) - {...} email=...` */
  if (/Attempt\s+\d+\/\d+\s*:\s*failed/i.test(line)) return true;
  return false;
}

function isInHouseSolverAttemptSucceeded(line: string): boolean {
  if (/in-house solver attempt succeeded/i.test(line)) return true;
  if (/Attempt\s+\d+\/\d+\s*:\s*passed/i.test(line)) return true;
  return false;
}

function buildPassportByEmailFromVfsLogs(logs: LogEntry[]): Map<string, string | null> {
  const sorted = [...logs].sort((a, b) => a.time.localeCompare(b.time));
  const m = new Map<string, string | null>();
  for (const e of sorted) {
    const email = extractField(e.line, "email")?.toLowerCase();
    if (!email) continue;
    const p = extractField(e.line, "PassportNumber") ?? extractField(e.line, "passport");
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

function lastFailureReasonInWindow(
  failLogs: LogEntry[],
  email: string,
  startMs: number,
  endMsExclusive: number
): string {
  let best = "";
  let bestMs = -Infinity;
  for (const e of failLogs) {
    if (!isNotAcceptedStyleFailure(e.line)) continue;
    const em = extractField(e.line, "email")?.toLowerCase();
    if (em !== email) continue;
    const t = Date.parse(e.time);
    if (!Number.isFinite(t)) continue;
    if (t < startMs || t >= endMsExclusive) continue;
    if (t >= bestMs) {
      bestMs = t;
      best = extractFailureReasonKey(e.line) ?? "";
    }
  }
  return best;
}

function lastFailureReasonInSessionWindow(
  failLogs: LogEntry[],
  sessionRef: string,
  startMs: number,
  endMsExclusive: number,
  urnToRef: Map<string, string>
): string {
  let best = "";
  let bestMs = -Infinity;
  for (const e of failLogs) {
    if (!isNotAcceptedStyleFailure(e.line)) continue;
    const urn = extractUrn(e.line);
    const ref = urn ? urnToRef.get(urn) : undefined;
    if (!ref || ref !== sessionRef) continue;
    const t = Date.parse(e.time);
    if (!Number.isFinite(t)) continue;
    if (t < startMs || t >= endMsExclusive) continue;
    if (t >= bestMs) {
      bestMs = t;
      best = extractFailureReasonKey(e.line) ?? "";
    }
  }
  return best;
}

/** One in-house solve: synthetic leading `solving` + success/fail for this email in [start, end). */
function buildSyntheticSessionTimeline(
  email: string,
  startMs: number,
  endMsExclusive: number,
  emailTimeline: EmailTimelineEvent[]
): EmailTimelineEvent[] {
  const out: EmailTimelineEvent[] = [{ timeMs: startMs, email, kind: "solving" }];
  for (const e of emailTimeline) {
    if (e.email !== email) continue;
    if (e.kind === "solving") continue;
    if (e.timeMs < startMs) continue;
    if (e.timeMs >= endMsExclusive) continue;
    out.push(e);
  }
  out.sort((a, b) => {
    const d = a.timeMs - b.timeMs;
    if (d !== 0) return d;
    if (a.kind === "solving") return -1;
    if (b.kind === "solving") return 1;
    return 0;
  });
  return out;
}

function extractVideoUrlFromVfsAttemptLine(line: string): string | undefined {
  let v = extractField(line, "VideoLink") ?? extractField(line, "videoLink");
  if (!v) v = extractField(line, "videoUrl") ?? extractField(line, "VideoURL");
  if (v) return v;
  const um = line.match(/(https?:\/\/[^\s,]+)/i);
  if (um?.[1]) return um[1].replace(/[,;)`'"\]]+$/, "");
  return undefined;
}

/**
 * Session table video URLs: **only** the `In-house solver` Loki stream (same source as approved-videos samples).
 * `Attempt n/m: …` lines do not carry `VideoLink=` — do not use them here. Any solver line for this email in the
 * window with `VideoLink=` / `videoLink=` (or a bare video `https://` after other fields) is included, time-ordered.
 */
function collectSolverAttemptVideosForSession(params: {
  solverLogs: LogEntry[];
  email: string;
  startMs: number;
  endMsExclusive: number;
}): string[] {
  const { solverLogs, email, startMs, endMsExclusive } = params;
  const seen = new Set<string>();
  const withTime: { t: number; url: string }[] = [];
  const sorted = [...solverLogs].sort((a, b) => a.time.localeCompare(b.time));
  for (const entry of sorted) {
    const line = entry.line;
    const em = extractField(line, "email")?.toLowerCase();
    if (em !== email) continue;
    const video =
      extractField(line, "VideoLink") ??
      extractField(line, "videoLink") ??
      extractVideoUrlFromVfsAttemptLine(line);
    if (!video) continue;
    const t = Date.parse(entry.time);
    if (!Number.isFinite(t) || t < startMs || t >= endMsExclusive) continue;
    if (seen.has(video)) continue;
    seen.add(video);
    withTime.push({ t, url: video });
  }
  withTime.sort((a, b) => a.t - b.t);
  return withTime.map((x) => x.url);
}

/** e.g. `[JOB_ID:f492f1ec]` */
function extractAzureLineJobId(line: string): string | null {
  const m = line.match(/\[JOB_ID:([a-f0-9-]+)\]/i);
  const id = m?.[1]?.trim().toLowerCase();
  return id && id.length > 0 ? id : null;
}

/** `… [RECORDING] Uploaded: https://…mp4` (staging / screen capture). */
function parseAzureUploadedRecordingUrl(line: string): string | null {
  if (!/\buploaded\s*:/i.test(line)) return null;
  const m = line.match(/Uploaded:\s*(https?:\/\/\S+)/i);
  let u = m?.[1]?.trim() ?? "";
  u = u.replace(/[`'"()[\],;]+$/, "");
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

/** Correlate Azure recording line to VFS identity `TaskId` via `[JOB_ID:…]` and/or URL path. */
function azureUploadedRecordingMatchesVfsTask(line: string, vfsTaskId: string): boolean {
  const task = vfsTaskId.trim().toLowerCase();
  if (!task) return false;
  const taskCompact = task.replace(/-/g, "");
  const taskPrefix = taskIdToSessionPrefix(task);

  const job = extractAzureLineJobId(line);
  if (job) {
    if (task === job) return true;
    if (task.startsWith(`${job}-`)) return true;
    if (taskPrefix && job === taskPrefix) return true;
    const jobCompact = job.replace(/-/g, "");
    if (jobCompact.length >= 4 && taskCompact.startsWith(jobCompact)) return true;
  }

  const url = parseAzureUploadedRecordingUrl(line)?.toLowerCase() ?? "";
  if (url) {
    if (url.includes(task)) return true;
    if (taskCompact.length >= 8 && url.includes(taskCompact)) return true;
    if (taskPrefix.length >= 4 && url.includes(taskPrefix)) return true;
  }
  return false;
}

/** Screen-recording uploads from Azure liveness logs for this identity session (time padded for upload lag). */
function collectAzureScreenRecordingUrlsForSession(params: {
  azureRecordingLogs: LogEntry[];
  vfsTaskId: string;
  startMs: number;
  endMsExclusive: number;
}): string[] {
  const { azureRecordingLogs, vfsTaskId, startMs, endMsExclusive } = params;
  const padStart = startMs - 2 * 60 * 1000;
  const padEnd =
    endMsExclusive === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : endMsExclusive + 20 * 60 * 1000;
  const seen = new Set<string>();
  const withTime: { t: number; url: string }[] = [];
  const sorted = [...azureRecordingLogs].sort((a, b) => a.time.localeCompare(b.time));
  for (const entry of sorted) {
    const line = entry.line;
    if (!/\[RECORDING\][^\n]*uploaded\s*:/i.test(line) && !/\buploaded\s*:\s*https?:\/\//i.test(line)) continue;
    if (!azureUploadedRecordingMatchesVfsTask(line, vfsTaskId)) continue;
    const url = parseAzureUploadedRecordingUrl(line);
    if (!url) continue;
    const t = Date.parse(entry.time);
    if (!Number.isFinite(t) || t < padStart || t >= padEnd) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    withTime.push({ t, url });
  }
  withTime.sort((a, b) => a.t - b.t);
  return withTime.map((x) => x.url);
}

/** Error text from `In-house solver attempt failed … Error=… email=` or `Attempt n/m: failed … - {…}`. */
function extractSolverAttemptError(line: string): string | null {
  const m = line.match(/Error=(.+?)\s+email=/i);
  const raw = m?.[1]?.trim();
  if (raw && raw.length > 0) return raw;
  const m2 = line.match(/Attempt\s+\d+\/\d+\s*:\s*failed\s*\([^)]*\)\s*-\s*(.+)$/i);
  const raw2 = m2?.[1]?.trim();
  return raw2 && raw2.length > 0 ? raw2 : null;
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
  if (/not approved after in-house solves/i.test(line)) return true;
  /** e.g. `In-house identity verification failed [Attempt=1/1]: In-house verification failed [solves=3/3, passport=…]` */
  if (
    /\[Attempt\s*=\s*1\s*\/\s*1\]/i.test(line) &&
    /in-house verification failed/i.test(line)
  ) {
    return true;
  }
  return false;
}

function isInHouseIdentityCompletedLine(line: string): boolean {
  return /in-house identity verification completed\b/i.test(line);
}

function isInHouseVerificationPassedLine(line: string): boolean {
  return /in-house verification passed\b/i.test(line);
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

/** `Activated in-house identity verification token [ReferenceNumber: uuid]` */
function extractActivatedReferenceNumber(line: string): string | undefined {
  const m = line.match(/\[ReferenceNumber:\s*([a-f0-9-]+)\]/i);
  return m?.[1]?.trim();
}

function extractUrn(line: string): string | undefined {
  const m = line.match(/\burn=([^\s]+)/i);
  return m?.[1]?.trim().toLowerCase();
}

function buildUrnToReferenceMap(activationEntries: LogEntry[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of activationEntries) {
    const ref = extractActivatedReferenceNumber(e.line)?.toLowerCase();
    const urn = extractUrn(e.line);
    if (ref && urn) m.set(urn, ref);
  }
  return m;
}

function payloadSessionIdMatchesReference(payloadSessionId: string, referenceNumber: string): boolean {
  const ref = referenceNumber.trim().toLowerCase();
  const sid = payloadSessionId.trim().toLowerCase();
  if (!ref || !sid) return false;
  if (sid === ref) return true;
  if (sid.startsWith(`${ref}-`)) return true;
  return taskIdToSessionPrefix(sid) === taskIdToSessionPrefix(ref);
}

/** `videoUrl` from Azure `[REDIS][PAYLOAD]` lines whose `sessionId` / `id` matches ReferenceNumber (prefix rules). */
function collectVideoUrlsFromAzurePayloads(params: {
  azurePayloadLogs: LogEntry[];
  referenceNumber: string;
  startMs: number;
  endMsExclusive: number;
}): string[] {
  const { azurePayloadLogs, referenceNumber, startMs, endMsExclusive } = params;
  const seen = new Set<string>();
  const withTime: { t: number; url: string }[] = [];
  const sorted = [...azurePayloadLogs].sort((a, b) => a.time.localeCompare(b.time));
  for (const entry of sorted) {
    const line = entry.line;
    if (!line.includes("[REDIS][PAYLOAD]")) continue;
    const payloadMatch = line.match(/payload=(\{.+\})\s*$/);
    if (!payloadMatch?.[1]) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadMatch[1]) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payloadSessionId =
      typeof payload.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : typeof payload.id === "string" && payload.id.trim()
          ? payload.id.trim()
          : "";
    if (!payloadSessionIdMatchesReference(payloadSessionId, referenceNumber)) continue;
    const videoUrl = typeof payload.videoUrl === "string" ? payload.videoUrl.trim() : "";
    if (!videoUrl) continue;
    const t = Date.parse(entry.time);
    if (!Number.isFinite(t) || t < startMs || t >= endMsExclusive) continue;
    if (seen.has(videoUrl)) continue;
    seen.add(videoUrl);
    withTime.push({ t, url: videoUrl });
  }
  withTime.sort((a, b) => a.t - b.t);
  return withTime.map((x) => x.url);
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
  if (/Activated in-house identity verification token/i.test(line) && /\[ReferenceNumber:/i.test(line)) {
    return { kind: "solving" };
  }
  const attemptPass = line.match(/\bAttempt\s+(\d+)\s*\/\s*(\d+)\s*:\s*passed\b/i);
  if (attemptPass) {
    const submitN = parseInt(attemptPass[1], 10);
    const submitM = parseInt(attemptPass[2], 10);
    return {
      kind: "success",
      submitN: Number.isFinite(submitN) ? submitN : undefined,
      submitM: Number.isFinite(submitM) ? submitM : undefined,
    };
  }
  const attemptFail = line.match(/\bAttempt\s+(\d+)\s*\/\s*(\d+)\s*:\s*failed\b/i);
  if (attemptFail) {
    const failN = parseInt(attemptFail[1], 10);
    const failM = parseInt(attemptFail[2], 10);
    return {
      kind: "fail",
      failN: Number.isFinite(failN) ? failN : undefined,
      failM: Number.isFinite(failM) ? failM : undefined,
    };
  }
  if (line.includes("Solving in-house identity verification")) return { kind: "solving" };
  if (/in-house verification passed/i.test(line)) {
    const m =
      line.match(/\[solves\s*=\s*(\d+)\s*\/\s*(\d+)/i) ?? line.match(/\bsolves\s*=\s*(\d+)\s*\/\s*(\d+)/i);
    const submitN = m?.[1] ? parseInt(m[1], 10) : NaN;
    const submitM = m?.[2] ? parseInt(m[2], 10) : NaN;
    if (Number.isFinite(submitN) && Number.isFinite(submitM)) {
      return { kind: "success", submitN, submitM };
    }
    return { kind: "success" };
  }
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

function logEntryToSessionTimelineEvent(
  e: LogEntry,
  urnToRef: Map<string, string>
): { ev: EmailTimelineEvent; sessionRef: string } | null {
  const cls = classifyVfsVerificationLine(e.line);
  if (!cls) return null;
  const timeMs = Date.parse(e.time);
  if (!Number.isFinite(timeMs)) return null;
  const email = extractField(e.line, "email");
  if (!email) return null;
  const base = { timeMs, email: email.toLowerCase(), kind: cls.kind } as const;
  let ev: EmailTimelineEvent;
  if (cls.kind === "fail") {
    ev = { ...base, kind: "fail", failN: cls.failN, failM: cls.failM };
  } else if (cls.kind === "success") {
    ev = { ...base, kind: "success", submitN: cls.submitN, submitM: cls.submitM };
  } else {
    ev = { ...base, kind: "solving" };
  }

  const actRef = extractActivatedReferenceNumber(e.line)?.toLowerCase();
  if (cls.kind === "solving" && actRef) {
    return { ev, sessionRef: actRef };
  }
  const urn = extractUrn(e.line);
  const sessionRef = urn ? urnToRef.get(urn) : undefined;
  if (!sessionRef) return null;
  return { ev, sessionRef };
}

function mergeSessionRefTimelines(
  urnToRef: Map<string, string>,
  logStreams: LogEntry[][]
): Map<string, EmailTimelineEvent[]> {
  const byRef = new Map<string, EmailTimelineEvent[]>();
  for (const logs of logStreams) {
    for (const entry of logs) {
      const parsed = logEntryToSessionTimelineEvent(entry, urnToRef);
      if (!parsed) continue;
      const arr = byRef.get(parsed.sessionRef) ?? [];
      arr.push(parsed.ev);
      byRef.set(parsed.sessionRef, arr);
    }
  }
  for (const arr of byRef.values()) {
    arr.sort((a, b) => a.timeMs - b.timeMs || a.kind.localeCompare(b.kind));
  }
  return byRef;
}

function deriveApplicantOutcome(
  email: string,
  eventsAll: EmailTimelineEvent[],
  referenceNumber?: string
): ApplicantOutcome {
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

  const baseOut: ApplicantOutcome = { email, outcome, successOnTry };
  if (referenceNumber) return { ...baseOut, referenceNumber };
  return baseOut;
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

function buildSolvingSnapshotsByEmail(activationAnchorLogs: LogEntry[]): Map<string, SolvingSnapshot[]> {
  const byEmail = new Map<string, SolvingSnapshot[]>();
  for (const entry of activationAnchorLogs) {
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

function lokiLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function queryLogs(params: {
  base: string;
  cookieHeader: string;
  from: number;
  to: number;
  app: string;
  /** When set, stream selector is `{namespace, app}` (staging VFS etc.). */
  lokiNamespace?: string | null;
  query: string;
  requestId?: string;
}): Promise<LogEntry[]> {
  const { base, cookieHeader, from, to, app, lokiNamespace, query, requestId = "approved_videos_1" } = params;
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
  const appEsc = lokiLabelValue(app);
  const selector =
    lokiNamespace && lokiNamespace.trim().length > 0
      ? `{namespace="${lokiLabelValue(lokiNamespace.trim())}", app="${appEsc}"}`
      : `{app="${appEsc}"}`;
  const expr = `${selector} |= \`${query.replace(/`/g, "\\`")}\``;
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
    /** `prod` (default): VFS `{app}`, Azure `azure-liveness-bot`. `staging`: VFS `{namespace="staging", app}`, Azure `azure-liveness-automation-staging`. */
    deploymentEnv?: string;
    includeVideoSessionRows?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const solveKind: SolveKind =
    body.solveKind === "verification" || body.solveKind === "drop" ? body.solveKind : "drop";

  const deploymentEnv: DeploymentEnv =
    body.deploymentEnv === "staging" ? "staging" : "prod";

  const target = typeof body.target === "string" && body.target.trim() ? body.target.trim() : VFS_BOT_APP;
  const vfsLokiNamespace = deploymentEnv === "staging" ? LOKI_STAGING_NAMESPACE : null;
  const azureLivenessApp =
    deploymentEnv === "staging" ? AZURE_LIVENESS_BOT_APP_STAGING : AZURE_LIVENESS_BOT_APP_PROD;
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
    activationLogs,
    identityMiscLogs,
    identityFailTerminalLogs,
    legacySuccessLogs,
    solverLogsAll,
    verificationPassedLogs,
    vfsAttemptLogs,
    azureLivenessLogs,
    azurePayloadLogs,
    azureResultFailedLogs,
    azureRecordingLogs,
  ] =
    await Promise.all([
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      app: target,
      lokiNamespace: vfsLokiNamespace,
      query: "Activated in-house identity verification token",
      requestId: "approved_vfs_activation",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      app: target,
      lokiNamespace: vfsLokiNamespace,
      query: "In-house identity",
      requestId: "approved_vfs_identity_misc",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      app: target,
      lokiNamespace: vfsLokiNamespace,
      query: "In-house identity verification failed",
      requestId: "approved_vfs_identity_failed",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      app: target,
      lokiNamespace: vfsLokiNamespace,
      query: "Identity verification completed successfully",
      requestId: "approved_vfs_success",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      app: target,
      lokiNamespace: vfsLokiNamespace,
      query: "In-house solver",
      requestId: "approved_vfs_solver",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      app: target,
      lokiNamespace: vfsLokiNamespace,
      query: "In-house verification passed",
      requestId: "approved_vfs_verification_passed",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      app: target,
      lokiNamespace: vfsLokiNamespace,
      query: "Attempt",
      requestId: "approved_vfs_attempt",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      app: azureLivenessApp,
      query: "Solving face verification for session",
      requestId: "approved_azure_liveness",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      app: azureLivenessApp,
      query: "[REDIS][PAYLOAD]",
      requestId: "approved_azure_payload",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      app: azureLivenessApp,
      query: "[RESULT] FAILED",
      requestId: "approved_azure_result_failed",
    }),
    queryLogs({
      base,
      cookieHeader,
      from,
      to,
      app: azureLivenessApp,
      query: "Uploaded",
      requestId: "approved_azure_recording",
    }),
  ]);

  const identityOutcomeLogs = dedupeLogEntries([
    ...identityMiscLogs.filter(
      (entry) => !entry.line.includes("Solving in-house identity verification")
    ),
    ...identityFailTerminalLogs,
  ]);
  const identitySuccessLogs = dedupeLogEntries([
    ...identityOutcomeLogs.filter(
      (entry) =>
        isInHouseIdentityCompletedLine(entry.line) || isInHouseVerificationPassedLine(entry.line)
    ),
    ...verificationPassedLogs.filter((entry) => isInHouseVerificationPassedLine(entry.line)),
  ]);
  const successLogs = [...legacySuccessLogs, ...identitySuccessLogs].sort((a, b) =>
    a.time.localeCompare(b.time)
  );

  const vfsAttemptFiltered = vfsAttemptLogs.filter((e) =>
    /Attempt\s+\d+\/\d+\s*:\s*(passed|failed)/i.test(e.line)
  );
  const vfsSolverAndAttemptLogs = dedupeLogEntries([...solverLogsAll, ...vfsAttemptFiltered]);
  const identityFailLogs = identityOutcomeLogs.filter((entry) => {
    const c = classifyVfsVerificationLine(entry.line);
    return c?.kind === "fail";
  });
  const failLogs = identityFailLogs;

  const sessionSolveKind = buildSessionSolveKindMap(azureLivenessLogs);
  const urnToRef = buildUrnToReferenceMap(activationLogs);

  let solvingNoTaskId = 0;
  let solvingNoAzureMatch = 0;
  let solvingWrongKind = 0;
  const sessionAnchorLogs = activationLogs.filter((entry) => {
    const ref = extractActivatedReferenceNumber(entry.line);
    if (!ref) {
      solvingNoTaskId += 1;
      return false;
    }
    const prefix = taskIdToSessionPrefix(ref);
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

  const timelinesBySessionRef = mergeSessionRefTimelines(urnToRef, [
    activationLogs,
    successLogs,
    failLogs,
    vfsAttemptFiltered,
  ]);

  const orderedSessionRefs: string[] = [];
  const seenSessionRef = new Set<string>();
  for (const entry of [...sessionAnchorLogs].sort((a, b) => a.time.localeCompare(b.time))) {
    const ref = extractActivatedReferenceNumber(entry.line)?.toLowerCase();
    if (!ref || seenSessionRef.has(ref)) continue;
    seenSessionRef.add(ref);
    orderedSessionRefs.push(ref);
  }

  let applicantOutcomes: ApplicantOutcome[] = orderedSessionRefs.map((sessionRef) => {
    const anchor = [...sessionAnchorLogs]
      .sort((a, b) => a.time.localeCompare(b.time))
      .find((e) => extractActivatedReferenceNumber(e.line)?.toLowerCase() === sessionRef);
    const email = extractField(anchor?.line ?? "", "email")?.toLowerCase() ?? "";
    const events = timelinesBySessionRef.get(sessionRef) ?? [];
    return deriveApplicantOutcome(email, events, sessionRef);
  });

  const failedSessionRefSet = new Set(
    applicantOutcomes.filter((o) => o.outcome === "failed").map((o) => o.referenceNumber).filter(Boolean) as string[]
  );

  const solverFailCountBySessionRef = new Map<string, number>();
  for (const entry of vfsSolverAndAttemptLogs) {
    if (!isInHouseSolverAttemptFailed(entry.line)) continue;
    const urn = extractUrn(entry.line);
    const ref = urn ? urnToRef.get(urn) : undefined;
    if (!ref || !failedSessionRefSet.has(ref)) continue;
    solverFailCountBySessionRef.set(ref, (solverFailCountBySessionRef.get(ref) ?? 0) + 1);
  }

  applicantOutcomes = applicantOutcomes.map((o) =>
    o.outcome === "failed" && o.referenceNumber
      ? { ...o, solverFailureCount: solverFailCountBySessionRef.get(o.referenceNumber) ?? 0 }
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
  const solvingSnapshotsByEmail = buildSolvingSnapshotsByEmail(sessionAnchorLogs);
  for (const entry of vfsSolverAndAttemptLogs) {
    if (!isInHouseSolverAttemptFailed(entry.line)) continue;
    const email = extractField(entry.line, "email")?.toLowerCase();
    const urn = extractUrn(entry.line);
    const ref = urn ? urnToRef.get(urn) : undefined;
    if (ref) {
      if (!failedSessionRefSet.has(ref)) continue;
    } else if (!email || !failedEmailSet.has(email)) {
      continue;
    }
    const resolvedEmail =
      email ??
      (ref ? applicantOutcomes.find((o) => o.referenceNumber === ref)?.email : undefined) ??
      "";
    if (!resolvedEmail) continue;
    const errRaw = extractSolverAttemptError(entry.line);
    const reasonKey = errRaw ? normalizeFailureReasonKey(errRaw) : "(no Error= field)";
    const failureTimeMs = Date.parse(entry.time);
    const solvingSnap = Number.isFinite(failureTimeMs)
      ? pickSnapshotForFailure(solvingSnapshotsByEmail, resolvedEmail, failureTimeMs)
      : null;
    const passportFromLine =
      extractField(entry.line, "PassportNumber") ?? extractField(entry.line, "passport");
    const videoFromLine = extractField(entry.line, "VideoLink") ?? extractVideoUrlFromVfsAttemptLine(entry.line);
    const sample: FailureReasonSample = {
      email: resolvedEmail,
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

  const solvingTaskIds = [
    ...new Set(
      sessionAnchorLogs
        .map((e) => extractActivatedReferenceNumber(e.line) ?? "")
        .filter(Boolean)
    ),
  ];
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

  type VideoSessionRow = {
    email: string;
    taskId: string;
    videoLinks: string[];
    /** Azure liveness `[RECORDING] Uploaded: https://…` when present (e.g. staging screen capture). */
    screenRecordingUrls: string[];
    passportNumber: string | null;
  };
  type VideoSessionNotAcceptedRow = VideoSessionRow & { failureReason: string };

  let sessionVideoApprovedRows: VideoSessionRow[] | undefined;
  let sessionVideoNotAcceptedRows: VideoSessionNotAcceptedRow[] | undefined;

  if (body.includeVideoSessionRows === true) {
    const passportByEmail = buildPassportByEmailFromVfsLogs([
      ...identityOutcomeLogs,
      ...legacySuccessLogs,
      ...failLogs,
    ]);

    const activationSessions = [...sessionAnchorLogs].sort((a, b) => a.time.localeCompare(b.time));
    const nextActivationStartByIndex = new Map<number, number>();
    for (let i = 0; i < activationSessions.length; i++) {
      const emailI = extractField(activationSessions[i].line, "email")?.toLowerCase();
      if (!emailI) continue;
      const t0 = Date.parse(activationSessions[i].time);
      if (!Number.isFinite(t0)) continue;
      let endMs = Number.POSITIVE_INFINITY;
      for (let j = i + 1; j < activationSessions.length; j++) {
        const emailJ = extractField(activationSessions[j].line, "email")?.toLowerCase();
        if (emailJ !== emailI) continue;
        const t1 = Date.parse(activationSessions[j].time);
        if (Number.isFinite(t1)) endMs = t1;
        break;
      }
      nextActivationStartByIndex.set(i, endMs);
    }

    sessionVideoApprovedRows = [];
    sessionVideoNotAcceptedRows = [];

    for (let si = 0; si < activationSessions.length; si++) {
      const activationEntry = activationSessions[si];
      const email = extractField(activationEntry.line, "email")?.toLowerCase();
      const refRaw = extractActivatedReferenceNumber(activationEntry.line)?.trim() ?? "";
      const sessionRef = refRaw.toLowerCase();
      if (!email || !sessionRef) continue;
      const startMs = Date.parse(activationEntry.time);
      if (!Number.isFinite(startMs)) continue;
      const endMsExclusive = nextActivationStartByIndex.get(si) ?? Number.POSITIVE_INFINITY;

      const allEv = timelinesBySessionRef.get(sessionRef) ?? [];
      const windowEvents = allEv.filter((e) => e.timeMs >= startMs && e.timeMs < endMsExclusive);
      const sessionOutcome = deriveApplicantOutcome(email, windowEvents, sessionRef);

      const passportFromSolve =
        extractField(activationEntry.line, "PassportNumber") ??
        extractField(activationEntry.line, "passport");
      const passportNumber = passportFromSolve ?? passportByEmail.get(email) ?? null;

      const videoLinks = collectVideoUrlsFromAzurePayloads({
        azurePayloadLogs,
        referenceNumber: refRaw,
        startMs,
        endMsExclusive,
      });
      const screenRecordingUrls = collectAzureScreenRecordingUrlsForSession({
        azureRecordingLogs,
        vfsTaskId: refRaw,
        startMs,
        endMsExclusive,
      });
      if (videoLinks.length === 0 && screenRecordingUrls.length === 0) continue;

      if (sessionOutcome.outcome === "success") {
        sessionVideoApprovedRows.push({
          email,
          taskId: refRaw,
          videoLinks,
          screenRecordingUrls,
          passportNumber,
        });
      } else if (sessionOutcome.outcome === "failed") {
        sessionVideoNotAcceptedRows.push({
          email,
          taskId: refRaw,
          videoLinks,
          screenRecordingUrls,
          passportNumber,
          failureReason: lastFailureReasonInSessionWindow(
            failLogs,
            sessionRef,
            startMs,
            endMsExclusive,
            urnToRef
          ),
        });
      }
    }
  }

  return NextResponse.json({
    from,
    to,
    target,
    solveKind,
    deploymentEnv,
    vfsLokiNamespace,
    vfsCorrelationApp: target,
    azureCorrelationApp: azureLivenessApp,
    totals: {
      applicantCount: applicantOutcomes.length,
      successCount,
      failureCount,
      terminalFailureLogCount,
      pendingCount,
      solvedOnFirstTry,
      solvedOnSecondTry,
      solvedOnThirdTry,
      solvingLogLines: sessionAnchorLogs.length,
      solvingLogLinesRaw: activationLogs.length,
      successLogLines: successLogs.length,
      failLogLines: failLogs.length,
      identityVerificationLogLines: identityMiscLogs.length + identityFailTerminalLogs.length,
      identityOutcomeLogLines: identityOutcomeLogs.length,
      solverLogLines: vfsSolverAndAttemptLogs.length,
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

