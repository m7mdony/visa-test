import type { LogEntry, SolverAttempt } from "@/lib/inHouseVerVideos";
import {
  extractActivatedReferenceNumber,
  extractEmailFromLine,
  extractLogField,
  extractUrnFromLine,
  isActivationLine,
  parsePublishedResultLine,
} from "@/lib/inHouseVerVideos";

export type { SolverAttempt };

export type IdnfyNeverFailedRow = {
  email: string;
  passportNumber: string | null;
  urn: string | null;
  fromCountry: string | null;
  toCountry: string | null;
  failedAt: string;
  failedLine: string;
  token: string | null;
  activatedAt: string | null;
  activationLine: string | null;
  solves: SolverAttempt[];
  unresolvedReason?: string;
};

/** `Identity verification failed: … record new videos … /idnfystatus never returned APPROVED` */
export function isRecordNewVideosIdnfyNeverLine(line: string): boolean {
  return (
    /Identity verification failed/i.test(line) &&
    /record new videos/i.test(line) &&
    /\/idnfystatus never returned APPROVED/i.test(line)
  );
}

function findActivationBeforeFail(
  failEntry: LogEntry,
  activationLogs: LogEntry[],
  email: string
): LogEntry | null {
  const failMs = Date.parse(failEntry.time);
  if (!Number.isFinite(failMs)) return null;
  const failUrn = extractUrnFromLine(failEntry.line);

  const candidates = activationLogs.filter((entry) => {
    if (!isActivationLine(entry.line)) return false;
    const em = extractEmailFromLine(entry.line);
    if (em !== email) return false;
    const t = Date.parse(entry.time);
    if (!Number.isFinite(t) || t > failMs) return false;
    if (failUrn) {
      const urn = extractUrnFromLine(entry.line);
      if (urn && urn !== failUrn) return false;
    }
    return true;
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.time.localeCompare(a.time));
  return candidates[0];
}

function collectSolverAttemptsForToken(
  token: string,
  solverLogs: LogEntry[],
  activationMs: number,
  failMs: number
): SolverAttempt[] {
  const padStart = activationMs - 2 * 60 * 1000;
  const padEnd = failMs + 30 * 60 * 1000;
  const withTime: Array<{ t: number; parsed: NonNullable<ReturnType<typeof parsePublishedResultLine>>; at: string }> =
    [];

  for (const entry of solverLogs) {
    const parsed = parsePublishedResultLine(entry.line);
    if (!parsed || parsed.token !== token) continue;
    const t = Date.parse(entry.time);
    if (!Number.isFinite(t) || t < padStart || t > padEnd) continue;
    withTime.push({ t, parsed, at: entry.time });
  }

  withTime.sort((a, b) => a.t - b.t);
  return withTime.slice(0, 3).map((item, idx) => ({
    attempt: idx + 1,
    success: item.parsed.success,
    recordedVideoUrl: item.parsed.recordedVideoUrl,
    at: item.at,
    resultId: item.parsed.resultId,
  }));
}

export function buildIdnfyNeverFailedRows(params: {
  failLogs: LogEntry[];
  activationLogs: LogEntry[];
  solverLogs: LogEntry[];
}): IdnfyNeverFailedRow[] {
  const { failLogs, activationLogs, solverLogs } = params;
  const rows: IdnfyNeverFailedRow[] = [];

  const failures = failLogs
    .filter((e) => isRecordNewVideosIdnfyNeverLine(e.line))
    .sort((a, b) => a.time.localeCompare(b.time));

  for (const failEntry of failures) {
    const email = extractEmailFromLine(failEntry.line);
    if (!email) continue;

    const activation = findActivationBeforeFail(failEntry, activationLogs, email);
    const token = activation ? extractActivatedReferenceNumber(activation.line) : null;
    const failMs = Date.parse(failEntry.time);
    const activationMs = activation ? Date.parse(activation.time) : failMs;

    let solves: SolverAttempt[] = [];
    let unresolvedReason: string | undefined;

    if (!activation) {
      unresolvedReason = "No activation token found for this email before failure";
    } else if (!token) {
      unresolvedReason = "Activation line missing ReferenceNumber";
    } else {
      solves = collectSolverAttemptsForToken(token, solverLogs, activationMs, failMs);
      if (solves.length === 0) {
        unresolvedReason = "No solver Published result lines for token";
      }
    }

    rows.push({
      email,
      passportNumber:
        extractLogField(failEntry.line, "passportNumber") ??
        extractLogField(failEntry.line, "PassportNumber") ??
        (activation
          ? extractLogField(activation.line, "passportNumber") ??
            extractLogField(activation.line, "PassportNumber") ??
            null
          : null),
      urn: extractUrnFromLine(failEntry.line),
      fromCountry: extractLogField(failEntry.line, "fromCountry") ?? null,
      toCountry: extractLogField(failEntry.line, "toCountry") ?? null,
      failedAt: failEntry.time,
      failedLine: failEntry.line,
      token,
      activatedAt: activation?.time ?? null,
      activationLine: activation?.line ?? null,
      solves,
      unresolvedReason,
    });
  }

  return rows;
}
