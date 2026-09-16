import type { LogEntry, SolverAttempt } from "@/lib/inHouseVerVideos";
import {
  extractActivatedReferenceNumber,
  extractEmailFromLine,
  extractLogField,
  extractUrnFromLine,
  isActivationLine,
} from "@/lib/inHouseVerVideos";

export type { SolverAttempt };

export type WeCouldntDetectFaceRow = {
  email: string;
  passportNumber: string | null;
  urn: string | null;
  fromCountry: string | null;
  toCountry: string | null;
  errorCode: string | null;
  errorDescription: string | null;
  deniedAt: string;
  deniedLine: string;
  token: string | null;
  activatedAt: string | null;
  activationLine: string | null;
  solves: SolverAttemptWithError[];
  concurrentConflictCount: number;
  concurrentConflictSamples: string[];
  unresolvedReason?: string;
};

export type SolverAttemptWithError = SolverAttempt & {
  livenessError: string | null;
};

/** idnfystatus DENIED / warn with "We couldn't …" face-detection message */
export function isWeCouldntDetectFaceLine(line: string): boolean {
  if (!/We couldn't/i.test(line)) return false;
  return (
    /idnfystatus/i.test(line) ||
    /"status"\s*:\s*"DENIED"/i.test(line) ||
    /\[\d{3,4}\]\s*We couldn't/i.test(line)
  );
}

function extractLoginUserFromJson(line: string): string | null {
  const m = line.match(/"loginUser"\s*:\s*"([^"]+)"/i);
  const email = m?.[1]?.trim().toLowerCase();
  return email?.includes("@") ? email : null;
}

function extractErrorFromLine(line: string): { code: string | null; description: string | null } {
  const bracket = line.match(/\[(\d{3,4})\]\s*(We couldn't[^,\n]*)/i);
  if (bracket) {
    return { code: bracket[1], description: bracket[2].trim() };
  }
  const jsonCode = line.match(/"code"\s*:\s*(\d+)/i);
  const jsonDesc = line.match(/"description"\s*:\s*"([^"]+)"/i);
  if (jsonDesc?.[1]?.includes("We couldn't")) {
    return {
      code: jsonCode?.[1] ?? null,
      description: jsonDesc[1].trim(),
    };
  }
  const plain = line.match(/(We couldn't[^,\n"]*)/i);
  return { code: jsonCode?.[1] ?? null, description: plain?.[1]?.trim() ?? null };
}

function dedupeKey(email: string, urn: string | null, failMs: number): string {
  const bucket = Math.floor(failMs / 60_000);
  return `${email}|${urn ?? ""}|${bucket}`;
}

function findActivationBeforeDenial(
  denyEntry: LogEntry,
  activationLogs: LogEntry[],
  email: string
): LogEntry | null {
  const denyMs = Date.parse(denyEntry.time);
  if (!Number.isFinite(denyMs)) return null;
  const denyUrn = extractUrnFromLine(denyEntry.line);

  const candidates = activationLogs.filter((entry) => {
    if (!isActivationLine(entry.line)) return false;
    const em = extractEmailFromLine(entry.line);
    if (em !== email) return false;
    const t = Date.parse(entry.time);
    if (!Number.isFinite(t) || t > denyMs) return false;
    if (denyUrn) {
      const urn = extractUrnFromLine(entry.line);
      if (urn && urn !== denyUrn) return false;
    }
    return true;
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.time.localeCompare(a.time));
  return candidates[0];
}

function parseLivenessErrorFromLine(line: string): string | null {
  const m = line.match(/WASM liveness FAILED:\s*(\{[^}]+\})/i);
  if (!m?.[1]) return null;
  try {
    const obj = JSON.parse(m[1]) as { livenessError?: string };
    const err = obj.livenessError?.trim();
    return err && err !== "None" ? err : null;
  } catch {
    return null;
  }
}

function tokenJobIdPrefix(token: string): string {
  return token.split("-")[0].toLowerCase();
}

function tokenMatchesJobId(token: string, jobId: string): boolean {
  const prefix = tokenJobIdPrefix(token);
  const job = jobId.toLowerCase();
  return job === prefix || token.toLowerCase().startsWith(job);
}

/** `[WASM-JS] … session/attempt/end 409 … ConcurrentOperationConflict` */
export function isConcurrentOperationConflictLine(line: string): boolean {
  if (/ConcurrentOperationConflict/i.test(line)) return true;
  return (
    /session\/attempt\/end/i.test(line) &&
    /\b409\b/.test(line) &&
    /conflict/i.test(line)
  );
}

function solverLineMatchesToken(line: string, token: string): boolean {
  const prefix = tokenJobIdPrefix(token);
  if (line.includes(`[JOB_ID:${prefix}]`)) return true;
  if (line.includes(`Session ${prefix}`)) return true;
  if (line.includes(prefix) && /\[WASM-JS\]/i.test(line)) return true;
  return false;
}

function collectConcurrentConflictsForToken(
  token: string,
  wasmConflictLogs: LogEntry[],
  activationMs: number,
  denyMs: number
): { count: number; samples: string[] } {
  const padStart = activationMs - 2 * 60 * 1000;
  const padEnd = denyMs + 60 * 60 * 1000;
  const samples: string[] = [];

  for (const entry of wasmConflictLogs) {
    if (!isConcurrentOperationConflictLine(entry.line)) continue;
    if (!solverLineMatchesToken(entry.line, token)) continue;
    const t = Date.parse(entry.time);
    if (!Number.isFinite(t) || t < padStart || t > padEnd) continue;
    samples.push(entry.line);
  }

  return { count: samples.length, samples: samples.slice(0, 3) };
}

/** `[JOB_ID:cec802d1] [EFFECT-STREAM] https://…webm` */
export function parseEffectStreamLine(line: string): { jobId: string; videoUrl: string } | null {
  if (!/\[EFFECT-STREAM\]/i.test(line)) return null;
  const jobM = line.match(/\[JOB_ID:([a-f0-9-]+)\]/i);
  const urlM = line.match(/\[EFFECT-STREAM\]\s+(https?:\/\/[^\s]+)/i);
  if (!jobM?.[1] || !urlM?.[1]) return null;
  const videoUrl = urlM[1].trim();
  if (!/\.webm/i.test(videoUrl)) return null;
  return { jobId: jobM[1].trim().toLowerCase(), videoUrl };
}

function findLivenessErrorForAttempt(
  token: string,
  attemptAt: string,
  solverLogs: LogEntry[]
): string | null {
  const attemptMs = Date.parse(attemptAt);
  if (!Number.isFinite(attemptMs)) return null;
  const prefix = tokenJobIdPrefix(token);

  let best: { t: number; err: string } | null = null;
  for (const entry of solverLogs) {
    if (!/\[LIVENESS\].*FAILED/i.test(entry.line)) continue;
    if (!entry.line.includes(prefix) && !entry.line.includes(token)) continue;
    const err = parseLivenessErrorFromLine(entry.line);
    if (!err) continue;
    const t = Date.parse(entry.time);
    if (!Number.isFinite(t)) continue;
    const delta = Math.abs(t - attemptMs);
    if (delta > 120_000) continue;
    if (!best || delta < best.t) best = { t: delta, err };
  }
  return best?.err ?? null;
}

function collectEffectStreamRecordingsForToken(
  token: string,
  solverLogs: LogEntry[],
  activationMs: number,
  denyMs: number
): SolverAttemptWithError[] {
  const padStart = activationMs - 2 * 60 * 1000;
  const padEnd = denyMs + 60 * 60 * 1000;
  const withTime: Array<{ t: number; jobId: string; videoUrl: string; at: string }> = [];
  const seenUrls = new Set<string>();

  for (const entry of solverLogs) {
    const parsed = parseEffectStreamLine(entry.line);
    if (!parsed || !tokenMatchesJobId(token, parsed.jobId)) continue;
    if (seenUrls.has(parsed.videoUrl)) continue;
    const t = Date.parse(entry.time);
    if (!Number.isFinite(t) || t < padStart || t > padEnd) continue;
    seenUrls.add(parsed.videoUrl);
    withTime.push({ t, jobId: parsed.jobId, videoUrl: parsed.videoUrl, at: entry.time });
  }

  withTime.sort((a, b) => a.t - b.t);
  return withTime.slice(0, 3).map((item, idx) => {
    const livenessError = findLivenessErrorForAttempt(token, item.at, solverLogs);
    return {
      attempt: idx + 1,
      success: !livenessError,
      recordedVideoUrl: item.videoUrl,
      at: item.at,
      resultId: `${item.jobId}-${idx + 1}`,
      livenessError,
    };
  });
}

export function buildWeCouldntDetectFaceRows(params: {
  denyLogs: LogEntry[];
  activationLogs: LogEntry[];
  solverLogs: LogEntry[];
  wasmConflictLogs: LogEntry[];
}): WeCouldntDetectFaceRow[] {
  const { denyLogs, activationLogs, solverLogs, wasmConflictLogs } = params;
  const seen = new Set<string>();
  const rows: WeCouldntDetectFaceRow[] = [];

  const denials = denyLogs
    .filter((e) => isWeCouldntDetectFaceLine(e.line))
    .sort((a, b) => a.time.localeCompare(b.time));

  for (const denyEntry of denials) {
    const email =
      extractEmailFromLine(denyEntry.line) ?? extractLoginUserFromJson(denyEntry.line);
    if (!email) continue;

    const denyMs = Date.parse(denyEntry.time);
    if (!Number.isFinite(denyMs)) continue;

    const urn = extractUrnFromLine(denyEntry.line);
    const key = dedupeKey(email, urn, denyMs);
    if (seen.has(key)) continue;
    seen.add(key);

    const activation = findActivationBeforeDenial(denyEntry, activationLogs, email);
    const token = activation ? extractActivatedReferenceNumber(activation.line) : null;
    const activationMs = activation ? Date.parse(activation.time) : denyMs;

    let solves: SolverAttemptWithError[] = [];
    let concurrentConflictCount = 0;
    let concurrentConflictSamples: string[] = [];
    let unresolvedReason: string | undefined;

    if (!activation) {
      unresolvedReason = "No activation token found for this email before denial";
    } else if (!token) {
      unresolvedReason = "Activation line missing ReferenceNumber";
    } else {
      const conflicts = collectConcurrentConflictsForToken(
        token,
        wasmConflictLogs,
        activationMs,
        denyMs
      );
      concurrentConflictCount = conflicts.count;
      concurrentConflictSamples = conflicts.samples;

      solves = collectEffectStreamRecordingsForToken(token, solverLogs, activationMs, denyMs);
      if (solves.length === 0) {
        unresolvedReason = "No solver [EFFECT-STREAM] recordings for token";
      }
    }

    const { code, description } = extractErrorFromLine(denyEntry.line);

    rows.push({
      email,
      passportNumber:
        extractLogField(denyEntry.line, "passportNumber") ??
        extractLogField(denyEntry.line, "PassportNumber") ??
        (activation
          ? extractLogField(activation.line, "passportNumber") ??
            extractLogField(activation.line, "PassportNumber") ??
            null
          : null),
      urn,
      fromCountry: extractLogField(denyEntry.line, "fromCountry") ?? null,
      toCountry: extractLogField(denyEntry.line, "toCountry") ?? null,
      errorCode: code,
      errorDescription: description,
      deniedAt: denyEntry.time,
      deniedLine: denyEntry.line,
      token,
      activatedAt: activation?.time ?? null,
      activationLine: activation?.line ?? null,
      solves,
      concurrentConflictCount,
      concurrentConflictSamples,
      unresolvedReason,
    });
  }

  return rows;
}
