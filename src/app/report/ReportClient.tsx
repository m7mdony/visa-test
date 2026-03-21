"use client";

import { useState, useCallback, useEffect, Fragment } from "react";

type ParsedLog = {
  totalTime?: number;
  faceAttempts?: number;
  faceTime?: number;
  faceSolve?: number;
  faceGetResult?: number;
  passportAttempts?: number;
  passportTime?: number;
  faceValidationAttempts?: number;
  faceValidationTime?: number;
};

function parseLogLine(line: string): ParsedLog | null {
  const out: ParsedLog = {};
  const totalTimeMatch = line.match(/TotalTime=([\d.]+)s/);
  if (totalTimeMatch) out.totalTime = parseFloat(totalTimeMatch[1]);

  const fvMatch = line.match(/FaceVerification=\{[^}]*Attempts=(\d+)[^}]*Time=([\d.]+)s[^}]*Solve=([\d.]+)s[^}]*GetResult=([\d.]+)s/);
  if (fvMatch) {
    out.faceAttempts = parseInt(fvMatch[1], 10);
    out.faceTime = parseFloat(fvMatch[2]);
    out.faceSolve = parseFloat(fvMatch[3]);
    out.faceGetResult = parseFloat(fvMatch[4]);
  }

  const pvMatch = line.match(/PassportVerification=\{[^}]*Attempts=(\d+)[^}]*Time=([\d.]+)s/);
  if (pvMatch) {
    out.passportAttempts = parseInt(pvMatch[1], 10);
    out.passportTime = parseFloat(pvMatch[2]);
  }

  // FaceValidation can be a block with Attempts+Time, or a single value inside FaceVerification (e.g. FaceValidation=2.44s)
  const fvalBlockMatch = line.match(/FaceValidation=\{[^}]*Attempts=(\d+)[^}]*Time=([\d.]+)s/);
  if (fvalBlockMatch) {
    out.faceValidationAttempts = parseInt(fvalBlockMatch[1], 10);
    out.faceValidationTime = parseFloat(fvalBlockMatch[2]);
  } else {
    const fvalSimpleMatch = line.match(/FaceValidation=([\d.]+)s/);
    if (fvalSimpleMatch) {
      out.faceValidationTime = parseFloat(fvalSimpleMatch[1]);
      out.faceValidationAttempts = 1;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

type LogEntry = { time: string; line: string };

/** One row in an attempts-distribution bucket (click → session log drill-down). */
export type DistributionSessionRef = {
  sessionKey: string;
  displayLabel: string;
  /** Paired face vs passport duration (same index in session), for compare drill-down */
  faceSec?: number;
  passportSec?: number;
  /** 1-based index within that session’s paired face/passport timings */
  attemptPairIndex?: number;
};

/** Portal start → identity completed/failed window in sorted log order. */
export type IdentitySessionTrace = {
  sessionKey: string;
  displayLabel: string;
  email?: string;
  urn?: string;
  startSortedIndex: number;
  endSortedIndex: number;
  closed: boolean;
  outcome?: "success" | "failed";
  identityDurationSec: number | null;
  faceAttempts: number;
  passportAttempts: number;
};

type ReportMetrics = {
  count: number;
  identityVerificationsAvg: number;
  totalFaceAttempts: number;
  totalPassportAttempts: number;
  faceFailed: number;
  faceSuccess: number;
  passportFailed: number;
  passportSuccess: number;
  avgTotalTime: number;
  avgFaceAttemptsPerIdentity: number;
  avgFaceTime: number;
  avgFaceSessionInit: number;
  avgFaceSolve: number;
  avgPassportTime: number;
  avgPassportAttemptsPerIdentity: number;
  avgFaceValidationTime: number;
  avgFaceValidationAttemptsPerIdentity: number;
  avgFaceGetResult: number;
  faceAttemptsDistribution: Array<{
    attempts: number;
    identities: number;
    sessions: DistributionSessionRef[];
  }>;
  passportAttemptsDistribution: Array<{
    attempts: number;
    identities: number;
    sessions: DistributionSessionRef[];
  }>;
  passportSlowerThanFace: number;
  faceSlowerThanPassport: number;
  passportSlowerThanFaceSessions: DistributionSessionRef[];
  faceSlowerThanPassportSessions: DistributionSessionRef[];
};

export type ComputeMetricsResult = {
  metrics: ReportMetrics;
  sortedLogs: LogEntry[];
  sessionTraces: Record<string, IdentitySessionTrace>;
};

/** Identity-level rollup (e.g. "Identity verification failed: face verification failed [Attempts=5]") — not one face attempt. */
function isIdentityLevelFaceSummaryLine(line: string): boolean {
  const l = line.toLowerCase();
  return (
    l.includes("identity verification failed") &&
    l.includes("face verification failed") &&
    /\battempts=\d+/i.test(line)
  );
}

/** Per-attempt face success/fail lines only (case-insensitive); excludes rollups and "exhausted all retries" summary. */
function isPerAttemptFaceLine(line: string): boolean {
  const l = line.toLowerCase();
  if (!l.includes("face verification")) return false;
  if (line.includes("[VerifyJob] - Face verification completed successfully")) return false;
  if (isIdentityLevelFaceSummaryLine(line)) return false;
  if (/face verification failed:\s*exhausted all retries/i.test(l)) return false;
  const isSuccess = l.includes("face verification completed successfully");
  const isFailed = l.includes("face verification failed");
  return isSuccess || isFailed;
}

/**
 * When Loki returns the same timestamp for several lines, sort so session-close runs *after*
 * per-attempt face logs (otherwise FIFO closes the session and the last attempts aren't attributed).
 */
function sameTimestampProcessingRank(line: string): number {
  const l = line.toLowerCase();
  if (l.includes("initiating identity verification portal")) return 0;
  if (
    l.includes("identity verification completed successfully") ||
    l.includes("identity verification failed")
  ) {
    return 30;
  }
  if (isPerAttemptFaceLine(line)) return 10;
  return 20;
}

/** From `Identity verification completed successfully ... FaceVerification={Attempts=3,...}` */
function parseFaceAttemptsFromIdentitySuccessRollup(line: string): number | null {
  if (!line.includes("Identity verification completed successfully")) return null;
  const m = line.match(/FaceVerification=\{\s*Attempts=(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function parsePassportAttemptsFromIdentitySuccessRollup(line: string): number | null {
  if (!line.includes("Identity verification completed successfully")) return null;
  const m = line.match(/PassportVerification=\{\s*Attempts=(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** From `Identity verification failed: face verification failed [Attempts=5]` */
function parseFaceAttemptsFromIdentityFailureRollup(line: string): number | null {
  if (!line.includes("Identity verification failed")) return null;
  const m = line.match(/face verification failed\s*\[\s*Attempts=(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

type ComputeMetricsOptions = {
  /** When set, append human-readable trace lines (can be large). */
  debugLog?: string[];
};

function computeMetricsFromDetailedLogs(
  entries: LogEntry[],
  options?: ComputeMetricsOptions,
): ComputeMetricsResult | null {
  if (entries.length === 0) return null;

  const debugLog = options?.debugLog;
  const D = (msg: string) => {
    if (debugLog) debugLog.push(msg);
  };

  const withIndex = entries.map((e, originalIndex) => ({ ...e, originalIndex }));
  const sorted = withIndex.sort((a, b) => {
    const tc = a.time.localeCompare(b.time);
    if (tc !== 0) return tc;
    const ra = sameTimestampProcessingRank(a.line);
    const rb = sameTimestampProcessingRank(b.line);
    if (ra !== rb) return ra - rb;
    return a.originalIndex - b.originalIndex;
  });

  D(`--- metrics debug: ${sorted.length} lines after sort (stable index + same-ts rank) ---`);
  if (debugLog && sorted.length <= 400) {
    for (let i = 0; i < sorted.length; i++) {
      const { time, line, originalIndex: orig } = sorted[i];
      const rank = sameTimestampProcessingRank(line);
      const face = isPerAttemptFaceLine(line) ? "FACE" : "";
      const idc =
        line.includes("Identity verification completed successfully") ||
        line.includes("Identity verification failed")
          ? "ID_END"
          : "";
      const portal = line.includes("Initiating identity verification portal") ? "PORTAL" : "";
      if (face || idc || portal) {
        D(
          `  [${i}] t=${time} origIdx=${orig} rank=${rank} ${portal}${face}${idc} ${line.slice(0, 140)}${line.length > 140 ? "…" : ""}`,
        );
      }
    }
  } else if (debugLog) {
    D(`  (compact: Face / ID_END / PORTAL lines only; total ${sorted.length} lines) ---`);
    for (let i = 0; i < sorted.length; i++) {
      const { time, line, originalIndex: orig } = sorted[i];
      if (
        !isPerAttemptFaceLine(line) &&
        !line.includes("Identity verification completed successfully") &&
        !line.includes("Identity verification failed") &&
        !line.includes("Initiating identity verification portal")
      ) {
        continue;
      }
      D(
        `  [${i}] t=${time} origIdx=${orig} rank=${sameTimestampProcessingRank(line)} ${line.slice(0, 160)}${line.length > 160 ? "…" : ""}`,
      );
    }
  }

  // Attempts/success/failure (used for the "Attempts" section)
  let totalFaceAttempts = 0;
  let faceSuccess = 0;
  let faceFailed = 0;
  let totalPassportAttempts = 0;
  let passportSuccess = 0;
  let passportFailed = 0;

  // Passport "Initiating ..." → completion timing, scoped per identity *session* key
  const passportStartStacksBySession = new Map<string, number[]>();

  // Per-attempt timing sums (all averages below except total are per attempt)
  let identityCountForTiming = 0;
  let sumIdentityTotalTime = 0;

  let sumFaceTime = 0;
  let faceTimeCount = 0;
  let sumFaceSessionInit = 0;
  let faceSessionInitCount = 0;
  let sumFaceSolve = 0;
  let faceSolveCount = 0;
  let sumFaceGetResult = 0;
  let faceGetResultCount = 0;

  let sumPassportTime = 0;
  let passportTimeCount = 0;

  let sumFaceValidationTime = 0;
  let faceValidationCount = 0;

  // Per *identity verification session* (portal start → success/fail). Same email can repeat across sessions.
  const identityAttemptStats = new Map<
    string,
    {
      faceAttempts: number;
      passportAttempts: number;
      faceTimes: number[];
      passportTimes: number[];
      email?: string;
      urn?: string;
    }
  >();

  /** Oldest-open first (FIFO) for pairing completion lines; extra completions with empty queue are ignored. */
  const openIdentitySessions: Array<{
    key: string;
    startMs: number;
    startSortedIdx: number;
    urn?: string;
    email?: string;
  }> = [];
  let nextIdentitySessionId = 0;

  const sessionTraces = new Map<string, IdentitySessionTrace>();

  // Pair `FaceValidation=...` timings onto the corresponding face verification attempt times (per session key).
  const unassignedFaceAttemptIndicesBySession = new Map<string, number[]>();
  const pendingFaceValidationTimesBySession = new Map<string, number[]>();

  function getSessionStats(sessionKey: string) {
    let cur = identityAttemptStats.get(sessionKey);
    if (!cur) {
      cur = {
        faceAttempts: 0,
        passportAttempts: 0,
        faceTimes: [],
        passportTimes: [],
      };
      identityAttemptStats.set(sessionKey, cur);
    }
    return cur;
  }

  /** Prefer newest open session that matches urn, then email. No “sole open session” fallback — that mis-attributes other users’ lines when concurrency is low. */
  function findOpenSessionKeyForLine(urnLine?: string, emailLine?: string): string | null {
    if (openIdentitySessions.length === 0) return null;
    if (urnLine) {
      for (let i = openIdentitySessions.length - 1; i >= 0; i--) {
        const s = openIdentitySessions[i];
        if (s.urn && s.urn === urnLine) return s.key;
      }
    }
    if (emailLine) {
      for (let i = openIdentitySessions.length - 1; i >= 0; i--) {
        const s = openIdentitySessions[i];
        if (s.email && s.email === emailLine) return s.key;
      }
    }
    return null;
  }

  function labelForIdentity(sessionKey: string, email?: string, urn?: string): string {
    const e = email?.trim();
    if (e) return e;
    const u = urn?.trim();
    if (u) return `(no email in logs) ${u}`;
    if (sessionKey.includes("@")) return sessionKey;
    return `(session ${sessionKey})`;
  }

  for (let sortedIdx = 0; sortedIdx < sorted.length; sortedIdx++) {
    const { time, line, originalIndex: origIdx } = sorted[sortedIdx];
    const urnMatch = line.match(/\burn=([^\s]+)/);
    const urn = urnMatch?.[1]?.trim();
    const emailMatch = line.match(/email=([^\s]+)/);
    const email = emailMatch?.[1]?.trim();
    const identityKey = urn ?? email ?? "";

    const tsMs = Number.isFinite(Date.parse(time)) ? Date.parse(time) : NaN;

    // Used to prevent double-adding the same FaceValidation=... value to face verification time.
    let faceValidationAlreadyAddedToFaceTimeOnThisIteration = false;

    // Identity session: portal open → close on success/fail line whose email/urn matches that session (not blind FIFO).
    if (line.includes("Initiating identity verification portal")) {
      const sessionKey = `idv-${++nextIdentitySessionId}`;
      const stats = getSessionStats(sessionKey);
      if (email) stats.email = email;
      if (urn) stats.urn = urn;
      openIdentitySessions.push({
        key: sessionKey,
        startMs: tsMs,
        startSortedIdx: sortedIdx,
        urn: urn || undefined,
        email: email || undefined,
      });
      D(
        `[${sortedIdx}] PORTAL open ${sessionKey} queueLen=${openIdentitySessions.length} email=${email ?? "—"} urn=${urn ?? "—"} orig=${origIdx}`,
      );
    } else if (
      line.includes("Identity verification completed successfully") ||
      line.includes("Identity verification failed")
    ) {
      if (openIdentitySessions.length === 0) {
        D(`[${sortedIdx}] ID_END ignored (no open session) orig=${origIdx}`);
      } else {
        let closeIdx = -1;
        for (let i = 0; i < openIdentitySessions.length; i++) {
          const o = openIdentitySessions[i];
          if (logMarkersMatchLine(email, urn, o.email, o.urn)) {
            closeIdx = i;
            break;
          }
        }
        if (closeIdx < 0) {
          D(
            `[${sortedIdx}] ID_END orphan (no open portal matches completion email/urn) email=${email ?? "—"} urn=${urn ?? "—"} open=${openIdentitySessions.length} orig=${origIdx}`,
          );
        } else {
        const [sess] = openIdentitySessions.splice(closeIdx, 1);
        const s = getSessionStats(sess.key);

        if (line.includes("Identity verification completed successfully")) {
          const rollFace = parseFaceAttemptsFromIdentitySuccessRollup(line);
          const rollPass = parsePassportAttemptsFromIdentitySuccessRollup(line);
          if (rollFace != null && rollFace > s.faceAttempts) {
            const delta = rollFace - s.faceAttempts;
            D(
              `[${sortedIdx}] RECONCILE ${sess.key} faceAttempts ${s.faceAttempts}→${rollFace} (+${delta} from FaceVerification summary) orig=${origIdx}`,
            );
            totalFaceAttempts += delta;
            faceSuccess += delta;
            s.faceAttempts = rollFace;
          }
          if (rollPass != null && rollPass > s.passportAttempts) {
            const delta = rollPass - s.passportAttempts;
            D(
              `[${sortedIdx}] RECONCILE ${sess.key} passportAttempts ${s.passportAttempts}→${rollPass} (+${delta} from PassportVerification summary) orig=${origIdx}`,
            );
            totalPassportAttempts += delta;
            passportSuccess += delta;
            s.passportAttempts = rollPass;
          }
        } else {
          const rollFaceFail = parseFaceAttemptsFromIdentityFailureRollup(line);
          if (rollFaceFail != null && rollFaceFail > s.faceAttempts) {
            const delta = rollFaceFail - s.faceAttempts;
            D(
              `[${sortedIdx}] RECONCILE ${sess.key} faceAttempts ${s.faceAttempts}→${rollFaceFail} (+${delta} from identity-failure summary) orig=${origIdx}`,
            );
            totalFaceAttempts += delta;
            faceFailed += delta;
            s.faceAttempts = rollFaceFail;
          }
        }

        let identityDurationSec: number | null = null;
        if (!Number.isNaN(tsMs) && !Number.isNaN(sess.startMs)) {
          const diffSec = Math.max(0, (tsMs - sess.startMs) / 1000);
          identityDurationSec = diffSec;
          identityCountForTiming += 1;
          sumIdentityTotalTime += diffSec;
        }
        const stFinal = getSessionStats(sess.key);
        sessionTraces.set(sess.key, {
          sessionKey: sess.key,
          displayLabel: labelForIdentity(sess.key, stFinal.email, stFinal.urn),
          email: stFinal.email,
          urn: stFinal.urn,
          startSortedIndex: sess.startSortedIdx,
          endSortedIndex: sortedIdx,
          closed: true,
          outcome: line.includes("Identity verification completed successfully")
            ? "success"
            : "failed",
          identityDurationSec,
          faceAttempts: stFinal.faceAttempts,
          passportAttempts: stFinal.passportAttempts,
        });
        D(
          `[${sortedIdx}] ID_END closed ${sess.key} queueLen=${openIdentitySessions.length} orig=${origIdx}`,
        );
        }
      }
    }

    const sessionKeyForLine =
      identityKey !== "" ? findOpenSessionKeyForLine(urn, email) : null;

    // Face verification attempts (success + failed): per-attempt lines only; see isPerAttemptFaceLine
    if (isPerAttemptFaceLine(line)) {
      const l = line.toLowerCase();
      const isSuccess = l.includes("face verification completed successfully");
      const isFailed = l.includes("face verification failed");
      if (isSuccess || isFailed) {
        if (isFailed && isTlsRelated(line)) {
          D(`[${sortedIdx}] FACE skipped (TLS) orig=${origIdx}`);
          continue;
        }
        totalFaceAttempts += 1;
        if (isSuccess) faceSuccess += 1;
        if (isFailed) faceFailed += 1;

        const attemptNo = line.match(/\bAttempt=(\d+)/)?.[1];
        const jobId = line.match(/JobID=([a-f0-9-]+)/i)?.[1];
        if (sessionKeyForLine) {
          const s = getSessionStats(sessionKeyForLine);
          s.faceAttempts += 1;
          D(
            `[${sortedIdx}] FACE line +1 → ${sessionKeyForLine} (now faceAttempts=${s.faceAttempts}) Attempt=${attemptNo ?? "?"} JobID=${jobId ?? "—"} orig=${origIdx}`,
          );
        } else {
          D(
            `[${sortedIdx}] FACE line +1 → NO SESSION (not attributed) Attempt=${attemptNo ?? "?"} JobID=${jobId ?? "—"} openQueues=${openIdentitySessions.length} orig=${origIdx}`,
          );
        }

        const sessionInitMatch = line.match(/SessionInit=([\d.]+)s/);
        const solveMatch = line.match(/Solve=([\d.]+)s/);
        const getResultMatch = line.match(/GetResult=([\d.]+)s/);
        const timeTakenMatch = line.match(/TimeTaken=([\d.]+)s/);

        const sessionInit = sessionInitMatch ? parseFloat(sessionInitMatch[1]) : undefined;
        const solve = solveMatch ? parseFloat(solveMatch[1]) : undefined;
        const getResult = getResultMatch ? parseFloat(getResultMatch[1]) : undefined;
        const timeTaken = timeTakenMatch ? parseFloat(timeTakenMatch[1]) : undefined;

        if (sessionInit != null) {
          sumFaceSessionInit += sessionInit;
          faceSessionInitCount += 1;
        }
        if (solve != null) {
          sumFaceSolve += solve;
          faceSolveCount += 1;
        }
        if (getResult != null) {
          sumFaceGetResult += getResult;
          faceGetResultCount += 1;
        }

        const hasAllFaceParts = sessionInit != null && solve != null && getResult != null;
        const baseFaceTime =
          hasAllFaceParts
            ? sessionInit + solve + getResult
            : timeTaken != null
              ? timeTaken
              : sessionInit != null || solve != null || getResult != null
                ? (sessionInit ?? 0) + (solve ?? 0) + (getResult ?? 0)
                : undefined;

        if (baseFaceTime != null) {
          let v = baseFaceTime;
          let usedFaceValidation = false;

          // If validation is logged on the same line as the face attempt, attach immediately.
          const faceValidationOnSameLineMatch = line.match(/FaceValidation=([\d.]+)s/);
          if (faceValidationOnSameLineMatch) {
            const fval = parseFloat(faceValidationOnSameLineMatch[1]);
            v += fval;
            usedFaceValidation = true;
            faceValidationAlreadyAddedToFaceTimeOnThisIteration = true;
          } else if (sessionKeyForLine) {
            // Otherwise, if we already saw FaceValidation for this identity earlier, attach from the pending queue.
            const pending = pendingFaceValidationTimesBySession.get(sessionKeyForLine);
            if (pending && pending.length > 0) {
              const pendingFval = pending.shift()!;
              v += pendingFval;
              usedFaceValidation = true;
              if (pending.length === 0)
                pendingFaceValidationTimesBySession.delete(sessionKeyForLine);
            }
          }

          sumFaceTime += v;
          faceTimeCount += 1;
          if (sessionKeyForLine) {
            const s = getSessionStats(sessionKeyForLine);
            const faceIdx = s.faceTimes.length;
            s.faceTimes.push(v);

            // If FaceValidation wasn't attached yet, queue this attempt index for a future FaceValidation=... line.
            if (!usedFaceValidation) {
              const q = unassignedFaceAttemptIndicesBySession.get(sessionKeyForLine) ?? [];
              q.push(faceIdx);
              unassignedFaceAttemptIndicesBySession.set(sessionKeyForLine, q);
            }
          }
        }
      }
    }

    // Passport validation attempts and timings
    if (sessionKeyForLine && line.includes("Initiating passport validation")) {
      if (!Number.isNaN(tsMs)) {
        const stack = passportStartStacksBySession.get(sessionKeyForLine) ?? [];
        stack.push(tsMs);
        passportStartStacksBySession.set(sessionKeyForLine, stack);
      }
    } else if (
      sessionKeyForLine &&
      (line.includes("Passport validation completed successfully") ||
        line.includes("Passport validation failed"))
    ) {
      if (line.includes("Passport validation failed") && isTlsRelated(line)) {
        continue;
      }
      // Count attempts
      totalPassportAttempts += 1;
      if (sessionKeyForLine) {
        const s = getSessionStats(sessionKeyForLine);
        s.passportAttempts += 1;
      }
      if (line.includes("Passport validation completed successfully")) {
        passportSuccess += 1;
      } else if (line.includes("Passport validation failed")) {
        passportFailed += 1;
      }

      // Compute duration from last unmatched "Initiating passport validation" for this session
      const stack = passportStartStacksBySession.get(sessionKeyForLine);
      if (stack && stack.length > 0 && !Number.isNaN(tsMs)) {
        const startMs = stack.shift()!;
        const diffSec = Math.max(0, (tsMs - startMs) / 1000);
        sumPassportTime += diffSec;
        passportTimeCount += 1;
        passportStartStacksBySession.set(sessionKeyForLine, stack);
        if (sessionKeyForLine) {
          getSessionStats(sessionKeyForLine).passportTimes.push(diffSec);
        }
      }
    }

    // Face validation timings sometimes appear as FaceValidation=2.44s on detailed logs
    const fvalMatch = line.match(/FaceValidation=([\d.]+)s/);
    if (fvalMatch) {
      const fval = parseFloat(fvalMatch[1]);
      sumFaceValidationTime += fval;
      faceValidationCount += 1;

      // If we already added this FaceValidation value to face verification time for this same line,
      // don't attach it again to a queued attempt.
      if (!faceValidationAlreadyAddedToFaceTimeOnThisIteration) {
        if (sessionKeyForLine) {
          const q = unassignedFaceAttemptIndicesBySession.get(sessionKeyForLine);
          if (q && q.length > 0) {
            const faceIdx = q.shift()!;
            if (q.length === 0)
              unassignedFaceAttemptIndicesBySession.delete(sessionKeyForLine);

            const s = identityAttemptStats.get(sessionKeyForLine);
            if (s && Number.isFinite(s.faceTimes[faceIdx])) {
              s.faceTimes[faceIdx] += fval;
              sumFaceTime += fval;
            }
          } else {
            const pending = pendingFaceValidationTimesBySession.get(sessionKeyForLine) ?? [];
            pending.push(fval);
            pendingFaceValidationTimesBySession.set(sessionKeyForLine, pending);
          }
        }
      }
    }
  }

  for (const sess of openIdentitySessions) {
    const stAfter = getSessionStats(sess.key);
    sessionTraces.set(sess.key, {
      sessionKey: sess.key,
      displayLabel: labelForIdentity(sess.key, stAfter.email, stAfter.urn),
      email: stAfter.email,
      urn: stAfter.urn,
      startSortedIndex: sess.startSortedIdx,
      endSortedIndex: Math.max(0, sorted.length - 1),
      closed: false,
      outcome: undefined,
      identityDurationSec: null,
      faceAttempts: stAfter.faceAttempts,
      passportAttempts: stAfter.passportAttempts,
    });
  }

  D(
    `--- summary: totalFace=${totalFaceAttempts} totalPassport=${totalPassportAttempts} idClosures=${identityCountForTiming} sessionRows=${identityAttemptStats.size} stillOpen=${openIdentitySessions.length} ---`,
  );
  if (openIdentitySessions.length > 0 && debugLog) {
    D(
      `  still-open sessions: ${openIdentitySessions.map((s) => s.key).join(", ")} (no matching ID_END in range)`,
    );
  }

  if (
    totalFaceAttempts === 0 &&
    totalPassportAttempts === 0 &&
    identityCountForTiming === 0 &&
    identityAttemptStats.size === 0
  ) {
    return null;
  }

  const count =
    identityCountForTiming > 0
      ? identityCountForTiming
      : identityAttemptStats.size > 0
        ? identityAttemptStats.size
        : totalFaceAttempts > 0 || totalPassportAttempts > 0
          ? 1
          : 0;

  function buildAttemptDistribution(
    mode: "face" | "passport",
  ): Array<{
    attempts: number;
    identities: number;
    sessions: DistributionSessionRef[];
  }> {
    const bucketToSessions = new Map<number, DistributionSessionRef[]>();
    for (const [key, s] of identityAttemptStats) {
      const n = mode === "face" ? s.faceAttempts : s.passportAttempts;
      if (n <= 0) continue;
      const displayLabel = labelForIdentity(key, s.email, s.urn);
      const arr = bucketToSessions.get(n) ?? [];
      arr.push({ sessionKey: key, displayLabel });
      bucketToSessions.set(n, arr);
    }
    if (bucketToSessions.size === 0) return [];
    const maxAttempts = Math.max(...bucketToSessions.keys());
    const out: Array<{
      attempts: number;
      identities: number;
      sessions: DistributionSessionRef[];
    }> = [];
    for (let a = 1; a <= maxAttempts; a++) {
      const sessions = bucketToSessions.get(a);
      if (!sessions || sessions.length === 0) continue;
      sessions.sort(
        (x, y) =>
          x.displayLabel.localeCompare(y.displayLabel) ||
          x.sessionKey.localeCompare(y.sessionKey),
      );
      out.push({ attempts: a, identities: sessions.length, sessions });
    }
    return out;
  }

  const faceAttemptsDistribution = buildAttemptDistribution("face");
  const passportAttemptsDistribution = buildAttemptDistribution("passport");

  // Compare per-identity paired face/passport attempt durations (same index = paired attempt)
  let passportSlowerThanFace = 0;
  let faceSlowerThanPassport = 0;
  const passportSlowerThanFaceSessions: DistributionSessionRef[] = [];
  const faceSlowerThanPassportSessions: DistributionSessionRef[] = [];
  for (const [sessionKey, s] of identityAttemptStats) {
    const n = Math.min(s.faceTimes.length, s.passportTimes.length);
    const displayLabel = labelForIdentity(sessionKey, s.email, s.urn);
    for (let i = 0; i < n; i++) {
      const f = s.faceTimes[i];
      const p = s.passportTimes[i];
      if (!Number.isFinite(f) || !Number.isFinite(p)) continue;
      const ref: DistributionSessionRef = {
        sessionKey,
        displayLabel,
        faceSec: f,
        passportSec: p,
        attemptPairIndex: i + 1,
      };
      if (p > f) {
        passportSlowerThanFace += 1;
        passportSlowerThanFaceSessions.push(ref);
      } else if (f > p) {
        faceSlowerThanPassport += 1;
        faceSlowerThanPassportSessions.push(ref);
      }
    }
  }
  const cmpCompareSession = (a: DistributionSessionRef, b: DistributionSessionRef) => {
    const l = a.displayLabel.localeCompare(b.displayLabel);
    if (l !== 0) return l;
    const k = a.sessionKey.localeCompare(b.sessionKey);
    if (k !== 0) return k;
    return (a.attemptPairIndex ?? 0) - (b.attemptPairIndex ?? 0);
  };
  passportSlowerThanFaceSessions.sort(cmpCompareSession);
  faceSlowerThanPassportSessions.sort(cmpCompareSession);

  const sortedLogs: LogEntry[] = sorted.map(({ time, line }) => ({ time, line }));

  return {
    metrics: {
      count,
      identityVerificationsAvg: NaN,
      totalFaceAttempts,
      totalPassportAttempts,
      faceFailed,
      faceSuccess,
      passportFailed,
      passportSuccess,
      avgTotalTime: identityCountForTiming > 0 ? sumIdentityTotalTime / identityCountForTiming : 0,
      avgFaceAttemptsPerIdentity: NaN,
      avgFaceTime: faceTimeCount > 0 ? sumFaceTime / faceTimeCount : 0,
      avgFaceSessionInit: faceSessionInitCount > 0 ? sumFaceSessionInit / faceSessionInitCount : 0,
      avgFaceSolve: faceSolveCount > 0 ? sumFaceSolve / faceSolveCount : 0,
      avgFaceGetResult: faceGetResultCount > 0 ? sumFaceGetResult / faceGetResultCount : 0,
      avgPassportTime: passportTimeCount > 0 ? sumPassportTime / passportTimeCount : 0,
      avgPassportAttemptsPerIdentity: NaN,
      avgFaceValidationTime: faceValidationCount > 0 ? sumFaceValidationTime / faceValidationCount : 0,
      avgFaceValidationAttemptsPerIdentity: NaN,
      faceAttemptsDistribution,
      passportAttemptsDistribution,
      passportSlowerThanFace,
      faceSlowerThanPassport,
      passportSlowerThanFaceSessions,
      faceSlowerThanPassportSessions,
    },
    sortedLogs,
    sessionTraces: Object.fromEntries(sessionTraces),
  };
}

// Legacy helper kept for compatibility (not used in the new flow)
function computeMetrics(logs: { line: string }[]): ReportMetrics | null {
  const parsed = logs.map((l) => parseLogLine(l.line)).filter((p): p is ParsedLog => p != null);
  if (parsed.length === 0) return null;

  const count = parsed.length;
  const totalFaceAttempts = parsed.reduce((s, p) => s + (p.faceAttempts ?? 0), 0);
  const totalPassportAttempts = parsed.reduce((s, p) => s + (p.passportAttempts ?? 0), 0);
  const faceFailed = parsed.reduce((s, p) => s + Math.max(0, (p.faceAttempts ?? 1) - 1), 0);
  const passportFailed = parsed.reduce((s, p) => s + Math.max(0, (p.passportAttempts ?? 1) - 1), 0);

  const sumTotal = parsed.reduce((s, p) => s + (p.totalTime ?? 0), 0);
  const sumFaceTime = parsed.reduce((s, p) => s + (p.faceTime ?? 0), 0);
  const sumPassportTime = parsed.reduce((s, p) => s + (p.passportTime ?? 0), 0);
  const sumFaceValidationTime = parsed.reduce((s, p) => s + (p.faceValidationTime ?? 0), 0);
  const totalFaceValidationAttempts = parsed.reduce((s, p) => s + (p.faceValidationAttempts ?? 0), 0);
  const sumFaceSolve = parsed.reduce((s, p) => s + (p.faceSolve ?? 0), 0);
  const sumFaceGetResult = parsed.reduce((s, p) => s + (p.faceGetResult ?? 0), 0);
  const withTotal = parsed.filter((p) => p.totalTime != null).length;

  return {
    count,
    identityVerificationsAvg: NaN,
    totalFaceAttempts,
    totalPassportAttempts,
    faceFailed,
    faceSuccess: count,
    passportFailed,
    passportSuccess: count,
    avgTotalTime: withTotal ? sumTotal / withTotal : 0,
    avgFaceAttemptsPerIdentity: NaN,
    avgFaceTime: totalFaceAttempts > 0 ? sumFaceTime / totalFaceAttempts : 0,
    avgFaceSessionInit: 0,
    avgPassportTime: totalPassportAttempts > 0 ? sumPassportTime / totalPassportAttempts : 0,
    avgFaceValidationTime: totalFaceValidationAttempts > 0 ? sumFaceValidationTime / totalFaceValidationAttempts : 0,
    avgFaceSolve: totalFaceAttempts > 0 ? sumFaceSolve / totalFaceAttempts : 0,
    avgFaceGetResult: totalFaceAttempts > 0 ? sumFaceGetResult / totalFaceAttempts : 0,
    avgPassportAttemptsPerIdentity: NaN,
    avgFaceValidationAttemptsPerIdentity: NaN,
    faceAttemptsDistribution: [],
    passportAttemptsDistribution: [],
    passportSlowerThanFace: 0,
    faceSlowerThanPassport: 0,
    passportSlowerThanFaceSessions: [],
    faceSlowerThanPassportSessions: [],
  };
}


function fmt(s: number): string {
  return Number.isFinite(s) ? s.toFixed(2) : "—";
}

/** Hide vfs-global-bot debug-level lines in session log UI (Winston colorize + plain). */
function isSessionLogDebugLine(line: string): boolean {
  if (/\x1b\[3\d*mdebug\x1b\[[\d;]*m\s*:/i.test(line)) return true;
  if (/\[[0-9;]*mdebug\[[0-9;]*m\s*:/i.test(line)) return true;
  if (/\d{2}:\d{2}:\d{2}\.\d{3}\s+debug\s*:/i.test(line)) return true;
  return false;
}

/** `email=` / `urn=` on a log line vs session markers (portal / trace). */
function logMarkersMatchLine(
  lineEmail?: string,
  lineUrn?: string,
  markerEmail?: string,
  markerUrn?: string,
): boolean {
  const le = lineEmail?.trim();
  const lu = lineUrn?.trim();
  const te = markerEmail?.trim();
  const tu = markerUrn?.trim();
  if (!le && !lu) return false;
  if (te && le && le !== te) return false;
  if (tu && lu && lu !== tu) return false;
  if (te && tu) {
    if (le && lu) return le === te && lu === tu;
    if (le) return le === te;
    if (lu) return lu === tu;
    return false;
  }
  if (te) return Boolean(le && le === te);
  if (tu) return Boolean(lu && lu === tu);
  return false;
}

/**
 * Session log window is a contiguous range in globally sorted logs — other identities' lines can fall
 * between portal and identity completion by timestamp. Keep only lines whose email=/urn= match this trace.
 */
function lineBelongsToSessionTrace(trace: IdentitySessionTrace, line: string): boolean {
  const le = line.match(/email=([^\s]+)/)?.[1]?.trim();
  const lu = line.match(/\burn=([^\s]+)/)?.[1]?.trim();
  if (!le && !lu) return false;
  return logMarkersMatchLine(le, lu, trace.email, trace.urn);
}

/** Real ESC + Winston-style visible `[34m` SGR tokens (no leading ESC). */
const SESSION_LOG_SGR =
  /\x1b\[([\d;]*)m|\[(\d+(?:;\d+)*)m/g;

const ANSI_FG: Record<number, string> = {
  30: "#242424",
  31: "#cd3131",
  32: "#0dbc79",
  33: "#b58900",
  34: "#2472c8",
  35: "#bc3fbc",
  36: "#11a8cd",
  37: "#e5e5e5",
};
const ANSI_BRIGHT: Record<number, string> = {
  90: "#666666",
  91: "#f14c4c",
  92: "#23d18b",
  93: "#f5f543",
  94: "#3b8eea",
  95: "#d670d6",
  96: "#29b8db",
  97: "#ffffff",
};

function applySgrCodes(codeStr: string, st: { color?: string; bold: boolean }) {
  const raw = codeStr.trim();
  const parts = raw === "" ? ["0"] : raw.split(";");
  let i = 0;
  while (i < parts.length) {
    const n = parseInt(parts[i], 10);
    if (Number.isNaN(n)) {
      i += 1;
      continue;
    }
    if (n === 0) {
      st.color = undefined;
      st.bold = false;
    } else if (n === 1) st.bold = true;
    else if (n === 22) st.bold = false;
    else if (n === 39) st.color = undefined;
    else if (n >= 30 && n <= 37) st.color = ANSI_FG[n];
    else if (n >= 90 && n <= 97) st.color = ANSI_BRIGHT[n];
    i += 1;
  }
}

type AnsiSeg = { text: string; color?: string; bold: boolean };

function parseAnsiSegments(input: string): AnsiSeg[] {
  const out: AnsiSeg[] = [];
  const st = { color: undefined as string | undefined, bold: false };
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(SESSION_LOG_SGR.source, "g");
  const push = (text: string) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev && prev.color === st.color && prev.bold === st.bold) prev.text += text;
    else out.push({ text, color: st.color, bold: st.bold });
  };
  while ((m = re.exec(input)) !== null) {
    push(input.slice(last, m.index));
    last = m.index + m[0].length;
    const g = m[1] !== undefined ? m[1] : m[2];
    applySgrCodes(g ?? "0", st);
  }
  push(input.slice(last));
  return out;
}

function stripSessionLogAnsi(input: string): string {
  return input.replace(SESSION_LOG_SGR, "");
}

function SessionLogAnsiLine({ value }: { value: string }) {
  const segs = parseAnsiSegments(value);
  return (
    <>
      {segs.map((s, i) => (
        <span
          key={i}
          style={s.bold || s.color ? { color: s.color, fontWeight: s.bold ? 600 : undefined } : undefined}
        >
          {s.text}
        </span>
      ))}
    </>
  );
}

function extractEmailsFromLogs(logs: { line: string }[]): string[] {
  const seen = new Set<string>();
  for (const { line } of logs) {
    const m = line.match(/email=([^\s]+)/);
    if (m) seen.add(m[1].trim());
  }
  return [...seen];
}

type FaceErrorEntry = { key: string; count: number; videoUrl?: string; sessionId?: string };
type PassportErrorEntry = { key: string; count: number; imageUrl?: string };

function isTlsRelated(line: string): boolean {
  return /\bTLS\b|\bssl\b|\bSSL\b|\btls\b/.test(line);
}

function parseFaceError(line: string): { key: string; videoUrl?: string; sessionId?: string } | null {
  if (!line.includes("Face verification failed")) return null;
  if (isTlsRelated(line)) return null;
  const videoUrl = line.match(/VideoURL=(https:\/\/[^\s,\]]+)/)?.[1];
  const sessionId = line.match(/SessionID[=:\s]+([a-f0-9-]+)/i)?.[1]
    ?? line.match(/SessionID: ([a-f0-9-]+)/i)?.[1];
  // Colon format first (e.g. "Face verification failed: Failed to get verification liveness result: TLS Client Retry Error:")
  // — different structure, no Message=; use full text after colon as unique key.
  if (line.includes("Face verification failed: ")) {
    const colonMatch = line.match(/Face verification failed:\s*([^\[]*?)(?=\s+\[|\s+email=|$)/);
    const key = colonMatch ? colonMatch[1].trim() || "Face verification failed" : "Face verification failed";
    return { key, videoUrl, sessionId };
  }
  // Bracket format: "Face verification failed [TimeTaken=..., Message=...]" -> use Message= as key
  if (line.match(/Face verification failed\s+\[/)) {
    const msgMatch = line.match(/Message=([^,\]]+)/);
    const key = msgMatch ? msgMatch[1].trim() : "Face verification failed";
    return { key, videoUrl, sessionId };
  }
  return null;
}

function parsePassportError(line: string): { key: string; imageUrl?: string } | null {
  const m = line.match(/Passport validation failed: ([^\[]+)/);
  if (!m) return null;
  if (isTlsRelated(line)) return null;
  const imageUrl = line.match(/PassportImageURL=(https:\/\/[^\s,\]]+)/)?.[1];
  return { key: m[1].trim(), imageUrl };
}

function aggregateFaceErrors(lines: string[]): FaceErrorEntry[] {
  const byKey = new Map<string, { count: number; videoUrl?: string; sessionId?: string }>();
  for (const line of lines) {
    const p = parseFaceError(line);
    if (!p) continue;
    const cur = byKey.get(p.key);
    if (!cur) {
      byKey.set(p.key, { count: 1, videoUrl: p.videoUrl, sessionId: p.sessionId });
    } else {
      cur.count += 1;
      if (!cur.videoUrl && p.videoUrl) cur.videoUrl = p.videoUrl;
      if (!cur.sessionId && p.sessionId) cur.sessionId = p.sessionId;
    }
  }
  return [...byKey.entries()].map(([key, v]) => ({ key, count: v.count, videoUrl: v.videoUrl, sessionId: v.sessionId }));
}

function aggregatePassportErrors(lines: string[]): PassportErrorEntry[] {
  const byKey = new Map<string, { count: number; imageUrl?: string }>();
  for (const line of lines) {
    const p = parsePassportError(line);
    if (!p) continue;
    const cur = byKey.get(p.key);
    if (!cur) {
      byKey.set(p.key, { count: 1, imageUrl: p.imageUrl });
    } else {
      cur.count += 1;
      if (!cur.imageUrl && p.imageUrl) cur.imageUrl = p.imageUrl;
    }
  }
  return [...byKey.entries()].map(([key, v]) => ({ key, count: v.count, imageUrl: v.imageUrl }));
}

/** From vfs "Face verification completed successfully [JobID=uuid, ..., VideoURL=...]" -> map prefix (first 8 chars of uuid) -> { fullJobId, videoUrl } */
function extractSuccessJobIds(lines: string[]): Map<string, { fullJobId: string; videoUrl: string }> {
  const map = new Map<string, { fullJobId: string; videoUrl: string }>();
  for (const line of lines) {
    if (!line.includes("Face verification completed successfully")) continue;
    const jobMatch = line.match(/JobID=([a-f0-9-]+)/i);
    const urlMatch = line.match(/VideoURL=(https:\/\/[^\s,\]]+)/);
    if (!jobMatch || !urlMatch) continue;
    const fullJobId = jobMatch[1];
    const prefix = fullJobId.slice(0, 8);
    if (!map.has(prefix)) map.set(prefix, { fullJobId, videoUrl: urlMatch[1] });
  }
  return map;
}

/** From vfs "Face verification failed [JobID=uuid, ..., VideoURL=...]" -> map prefix -> { fullJobId, videoUrl } */
function extractFailedJobIds(lines: string[]): Map<string, { fullJobId: string; videoUrl: string }> {
  const map = new Map<string, { fullJobId: string; videoUrl: string }>();
  for (const line of lines) {
    if (!line.includes("Face verification failed [") || !line.includes("JobID=")) continue;
    const jobMatch = line.match(/JobID=([a-f0-9-]+)/i);
    const urlMatch = line.match(/VideoURL=(https:\/\/[^\s,\]]+)/);
    if (!jobMatch || !urlMatch) continue;
    const fullJobId = jobMatch[1];
    const prefix = fullJobId.slice(0, 8);
    if (!map.has(prefix)) map.set(prefix, { fullJobId, videoUrl: urlMatch[1] });
  }
  return map;
}

type LivenessJobMetrics = {
  videoPrep?: number;
  videoFileLoaded?: number;
  browserSetup?: number;
  timeToHoldStill?: number;
  totalPublish?: number;
  websocketDisconnect?: number;
};

function parseLivenessJobLogs(entries: { time: string; line: string }[]): LivenessJobMetrics | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => a.time.localeCompare(b.time));
  const out: LivenessJobMetrics = {};
  const videoPrepMatch = sorted.find((e) => e.line.includes("[TIMING] Video prep:"));
  if (videoPrepMatch) {
    const m = videoPrepMatch.line.match(/\[TIMING\] Video prep: ([\d.]+)s/);
    if (m) out.videoPrep = parseFloat(m[1]);
  }
  const videoFileLoadedMatch = sorted.find((e) => e.line.includes("Video file loaded:") && e.line.includes("from analyze click"));
  if (videoFileLoadedMatch) {
    const m = videoFileLoadedMatch.line.match(/\(([\d.]+)s from analyze click\)/);
    if (m) out.videoFileLoaded = parseFloat(m[1]);
  }
  const setupMatch = sorted.find((e) => e.line.includes("Browser setup time for session"));
  if (setupMatch) {
    const m = setupMatch.line.match(/Browser setup time for session [^\s]+: ([\d.]+)s/);
    if (m) out.browserSetup = parseFloat(m[1]);
  }
  const holdStillEntry = sorted.find((e) => e.line.includes("Hold still"));
  if (holdStillEntry && sorted[0]) {
    const startMs = new Date(sorted[0].time).getTime();
    const holdMs = new Date(holdStillEntry.time).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(holdMs)) out.timeToHoldStill = (holdMs - startMs) / 1000;
  }
  const totalMatch = sorted.find((e) => e.line.includes("Total (job start to publish)"));
  if (totalMatch) {
    const m = totalMatch.line.match(/Total \(job start to publish\): ([\d.]+)s/);
    if (m) out.totalPublish = parseFloat(m[1]);
  }
  const wsMatch = sorted.find((e) => e.line.includes("websocket connection→disconnection"));
  if (wsMatch) {
    const m = wsMatch.line.match(/websocket connection→disconnection: ([\d.]+)s/);
    if (m) out.websocketDisconnect = parseFloat(m[1]);
  }
  return Object.keys(out).length > 0 ? out : null;
}

type LongExample = { jobId: string; videoUrl: string; value: number };

type LivenessReportSection = {
  avgVideoPrep: number;
  avgVideoFileLoaded: number;
  avgBrowserSetup: number;
  avgTimeToHoldStill: number;
  avgTotalPublish: number;
  avgWebsocketDisconnect: number;
  jobCount: number;
  longWebsocketCount: number;
  longWebsocketExamples: Array<{ jobId: string; videoUrl: string }>;
  longVideoPrep: { count: number; examples: LongExample[] };
  longVideoFileLoaded: { count: number; examples: LongExample[] };
  longBrowserSetup: { count: number; examples: LongExample[] };
  longTimeToHoldStill: { count: number; examples: LongExample[] };
};

type LivenessReport = {
  success: LivenessReportSection | null;
  failed: LivenessReportSection | null;
};

function take3WithValue<T extends { fullJobId: string; videoUrl: string }>(arr: (T & { value: number })[]): LongExample[] {
  return arr.slice(0, 3).map(({ fullJobId, videoUrl, value }) => ({ jobId: fullJobId, videoUrl, value }));
}

function computeLivenessSection(
  jobPrefixToMeta: Map<string, { fullJobId: string; videoUrl: string }>,
  jobPrefixToLogs: Map<string, { time: string; line: string }[]>
): LivenessReportSection | null {
  const metrics: LivenessJobMetrics[] = [];
  const longWebsocket: Array<{ fullJobId: string; videoUrl: string; ws: number }> = [];
  const longVideoPrep: Array<{ fullJobId: string; videoUrl: string; value: number }> = [];
  const longVideoFileLoaded: Array<{ fullJobId: string; videoUrl: string; value: number }> = [];
  const longBrowserSetup: Array<{ fullJobId: string; videoUrl: string; value: number }> = [];
  const longTimeToHoldStill: Array<{ fullJobId: string; videoUrl: string; value: number }> = [];

  for (const [prefix, entries] of jobPrefixToLogs) {
    const m = parseLivenessJobLogs(entries);
    if (!m) continue;
    const meta = jobPrefixToMeta.get(prefix);
    if (!meta) continue;
    metrics.push(m);
    if (m.websocketDisconnect != null && m.websocketDisconnect > 11) {
      longWebsocket.push({ ...meta, ws: m.websocketDisconnect });
    }
    if (m.videoPrep != null && m.videoPrep > 0.2) {
      longVideoPrep.push({ ...meta, value: m.videoPrep });
    }
    if (m.videoFileLoaded != null && m.videoFileLoaded > 0.2) {
      longVideoFileLoaded.push({ ...meta, value: m.videoFileLoaded });
    }
    if (m.browserSetup != null && m.browserSetup > 0.5) {
      longBrowserSetup.push({ ...meta, value: m.browserSetup });
    }
    if (m.timeToHoldStill != null && m.timeToHoldStill > 4) {
      longTimeToHoldStill.push({ ...meta, value: m.timeToHoldStill });
    }
  }
  if (metrics.length === 0) return null;
  const n = metrics.length;
  const sum = (get: (m: LivenessJobMetrics) => number | undefined) =>
    metrics.reduce((s, m) => s + (get(m) ?? 0), 0);
  const count = (get: (m: LivenessJobMetrics) => number | undefined) =>
    metrics.filter((m) => get(m) != null).length;
  const avg = (get: (m: LivenessJobMetrics) => number | undefined) => {
    const c = count(get);
    return c > 0 ? sum(get) / c : 0;
  };
  return {
    avgVideoPrep: avg((m) => m.videoPrep),
    avgVideoFileLoaded: avg((m) => m.videoFileLoaded),
    avgBrowserSetup: avg((m) => m.browserSetup),
    avgTimeToHoldStill: avg((m) => m.timeToHoldStill),
    avgTotalPublish: avg((m) => m.totalPublish),
    avgWebsocketDisconnect: avg((m) => m.websocketDisconnect),
    jobCount: n,
    longWebsocketExamples: longWebsocket.slice(0, 3).map(({ fullJobId, videoUrl }) => ({ jobId: fullJobId, videoUrl })),
    longWebsocketCount: longWebsocket.length,
    longVideoPrep: { count: longVideoPrep.length, examples: take3WithValue(longVideoPrep) },
    longVideoFileLoaded: { count: longVideoFileLoaded.length, examples: take3WithValue(longVideoFileLoaded) },
    longBrowserSetup: { count: longBrowserSetup.length, examples: take3WithValue(longBrowserSetup) },
    longTimeToHoldStill: { count: longTimeToHoldStill.length, examples: take3WithValue(longTimeToHoldStill) },
  };
}

function computeLivenessReport(
  successMeta: Map<string, { fullJobId: string; videoUrl: string }>,
  successLogs: Map<string, { time: string; line: string }[]>,
  failedMeta: Map<string, { fullJobId: string; videoUrl: string }>,
  failedLogs: Map<string, { time: string; line: string }[]>
): LivenessReport {
  return {
    success: computeLivenessSection(successMeta, successLogs),
    failed: failedLogs.size > 0 ? computeLivenessSection(failedMeta, failedLogs) : null,
  };
}

function LivenessSectionBlock({ section, fmt }: { section: LivenessReportSection; fmt: (n: number) => string }) {
  return (
    <>
      <ul className="space-y-1.5 text-sm mb-3">
        <li className="flex justify-between gap-4">
          <span className="text-zinc-700">Avg video prep time</span>
          <span className="font-medium tabular-nums">{fmt(section.avgVideoPrep)}s</span>
        </li>
        <li className="flex justify-between gap-4">
          <span className="text-zinc-700">Avg video file loaded (from analyze click)</span>
          <span className="font-medium tabular-nums">{fmt(section.avgVideoFileLoaded)}s</span>
        </li>
        <li className="flex justify-between gap-4">
          <span className="text-zinc-700">Avg browser setup time</span>
          <span className="font-medium tabular-nums">{fmt(section.avgBrowserSetup)}s</span>
        </li>
        <li className="flex justify-between gap-4">
          <span className="text-zinc-700">Avg time to &quot;Hold still&quot; (job start → screen)</span>
          <span className="font-medium tabular-nums">{fmt(section.avgTimeToHoldStill)}s</span>
        </li>
        <li className="flex justify-between gap-4">
          <span className="text-zinc-700">Avg total (job start to publish)</span>
          <span className="font-medium tabular-nums">{fmt(section.avgTotalPublish)}s</span>
        </li>
        <li className="flex justify-between gap-4">
          <span className="text-zinc-700">Avg websocket connection → disconnection</span>
          <span className="font-medium tabular-nums">{fmt(section.avgWebsocketDisconnect)}s</span>
        </li>
      </ul>
      {section.longWebsocketCount > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 mt-2">
          <div className="text-sm font-medium text-amber-900">Jobs with websocket &gt; 11s: {section.longWebsocketCount}</div>
          <div className="mt-2 text-xs space-y-2">
            {section.longWebsocketExamples.map((ex, i) => (
              <div key={i}>
                <span className="text-zinc-600">Job ID: </span>
                <code className="text-zinc-800">{ex.jobId}</code>
                {ex.videoUrl && (
                  <>
                    {" · "}
                    <a href={ex.videoUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline break-all">Video</a>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {section.longVideoPrep.count > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 mt-2">
          <div className="text-sm font-medium text-amber-900">Jobs with video prep &gt; 0.2s: {section.longVideoPrep.count}</div>
          <div className="mt-2 text-xs space-y-2">
            {section.longVideoPrep.examples.map((ex, i) => (
              <div key={i}>
                <span className="text-zinc-600">Job ID: </span>
                <code className="text-zinc-800">{ex.jobId}</code>
                <span className="text-zinc-600"> ({ex.value.toFixed(2)}s)</span>
                {ex.videoUrl && (
                  <>
                    {" · "}
                    <a href={ex.videoUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline break-all">Video</a>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {section.longVideoFileLoaded.count > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 mt-2">
          <div className="text-sm font-medium text-amber-900">Jobs with video file loaded &gt; 0.2s: {section.longVideoFileLoaded.count}</div>
          <div className="mt-2 text-xs space-y-2">
            {section.longVideoFileLoaded.examples.map((ex, i) => (
              <div key={i}>
                <span className="text-zinc-600">Job ID: </span>
                <code className="text-zinc-800">{ex.jobId}</code>
                <span className="text-zinc-600"> ({ex.value.toFixed(2)}s)</span>
                {ex.videoUrl && (
                  <>
                    {" · "}
                    <a href={ex.videoUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline break-all">Video</a>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {section.longBrowserSetup.count > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 mt-2">
          <div className="text-sm font-medium text-amber-900">Jobs with browser setup &gt; 0.5s: {section.longBrowserSetup.count}</div>
          <div className="mt-2 text-xs space-y-2">
            {section.longBrowserSetup.examples.map((ex, i) => (
              <div key={i}>
                <span className="text-zinc-600">Job ID: </span>
                <code className="text-zinc-800">{ex.jobId}</code>
                <span className="text-zinc-600"> ({ex.value.toFixed(2)}s)</span>
                {ex.videoUrl && (
                  <>
                    {" · "}
                    <a href={ex.videoUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline break-all">Video</a>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {section.longTimeToHoldStill.count > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 mt-2">
          <div className="text-sm font-medium text-amber-900">Jobs with time to &quot;Hold still&quot; &gt; 4s: {section.longTimeToHoldStill.count}</div>
          <div className="mt-2 text-xs space-y-2">
            {section.longTimeToHoldStill.examples.map((ex, i) => (
              <div key={i}>
                <span className="text-zinc-600">Job ID: </span>
                <code className="text-zinc-800">{ex.jobId}</code>
                <span className="text-zinc-600"> ({ex.value.toFixed(2)}s)</span>
                {ex.videoUrl && (
                  <>
                    {" · "}
                    <a href={ex.videoUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline break-all">Video</a>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

const INTERVAL_MS: Record<string, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

function toDatetimeLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

/** Loki/Grafana return UTC ISO strings; show this in the UI so it matches datetime-local From/To. */
function formatLogTimeLocal(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function sessionLogSearchHaystack(e: LogEntry): string {
  const plain = stripSessionLogAnsi(e.line);
  return `${e.time}\t${formatLogTimeLocal(e.time)}\t${plain}`.toLowerCase();
}

export default function ReportClient() {
  const now = Date.now();
  const defaultFrom = new Date(now - INTERVAL_MS["24h"]);
  const defaultTo = new Date(now);
  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(defaultFrom));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(defaultTo));
  const [additionalFilter, setAdditionalFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reportMetrics, setReportMetrics] = useState<ReportMetrics | null>(null);
  const [faceErrors, setFaceErrors] = useState<FaceErrorEntry[]>([]);
  const [passportErrors, setPassportErrors] = useState<PassportErrorEntry[]>([]);
  const [livenessReport, setLivenessReport] = useState<LivenessReport | null>(null);
  const [livenessTarget, setLivenessTarget] = useState<"liveness-bot" | "aws-liveness-automation-staging">(
    "liveness-bot"
  );
  const [identityPopup, setIdentityPopup] = useState<{
    title: string;
    sessions: DistributionSessionRef[];
    hint?: string;
  } | null>(null);
  const [sessionLogPopup, setSessionLogPopup] = useState<string | null>(null);
  const [sessionLogSearch, setSessionLogSearch] = useState("");
  const [reportSortedLogs, setReportSortedLogs] = useState<LogEntry[]>([]);
  const [reportSessionTraces, setReportSessionTraces] = useState<
    Record<string, IdentitySessionTrace>
  >({});
  const [metricsDebugEnabled, setMetricsDebugEnabled] = useState(false);
  const [metricsDebugText, setMetricsDebugText] = useState("");

  useEffect(() => {
    if (!identityPopup && !sessionLogPopup) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (sessionLogPopup) setSessionLogPopup(null);
      else setIdentityPopup(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [identityPopup, sessionLogPopup]);

  useEffect(() => {
    setSessionLogSearch("");
  }, [sessionLogPopup]);

  const applyPreset = useCallback((interval: string) => {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["24h"];
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    setFromStr(toDatetimeLocal(from));
    setToStr(toDatetimeLocal(to));
  }, []);

  async function handleGenerate() {
    setError(null);
    setIdentityPopup(null);
    setSessionLogPopup(null);
    setMetricsDebugText("");
    setReportSortedLogs([]);
    setReportSessionTraces({});
    setReportMetrics(null);
    setFaceErrors([]);
    setPassportErrors([]);
    setLivenessReport(null);
    setLoading(true);
    setLoadingProgress(null);
    const fromMs = new Date(fromStr).getTime();
    const toMs = new Date(toStr).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      setError("From must be before To (use valid date-time).");
      setLoading(false);
      return;
    }
    try {
      // 1) Portal logs to discover all emails (success + failed)
      setLoadingProgress("Fetching identity portal logs…");
      const portalRes = await fetch("/api/grafana-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromMs,
          to: toMs,
          target: "vfs-global-bot",
          query: "Initiating identity verification portal",
          ...(additionalFilter.trim() && { additionalFilter: additionalFilter.trim() }),
        }),
      });
      const portalData = await portalRes.json().catch(() => ({}));
      if (!portalRes.ok) {
        setError(portalData.error || `HTTP ${portalRes.status}`);
        return;
      }
      const portalLogs = (portalData.logs ?? []) as { time: string; line: string }[];

      const EMAIL_BATCH = 1;
      const LIVENESS_BATCH = 1;
      const sessionCount = Math.max(EMAIL_BATCH, LIVENESS_BATCH);

      setLoadingProgress(`Creating ${sessionCount} Grafana sessions…`);
      const sessionsRes = await fetch("/api/grafana-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: sessionCount }),
      });
      const sessionsData = await sessionsRes.json().catch(() => ({}));
      const sessionCookies: string[] = Array.isArray(sessionsData.cookies) ? sessionsData.cookies : [];
      if (sessionCookies.length === 0) {
        setError("Failed to create Grafana sessions");
        setLoadingProgress(null);
        return;
      }

      const emails = extractEmailsFromLogs(portalLogs);
      const allEntries: { time: string; line: string }[] = [];
      for (let start = 0; start < emails.length; start += EMAIL_BATCH) {
        const end = Math.min(start + EMAIL_BATCH, emails.length);
        setLoadingProgress(`Fetching logs for emails ${start + 1}-${end} of ${emails.length}…`);
        const batch = emails.slice(start, end);
        const results = await Promise.all(
          batch.map((email, i) =>
            fetch("/api/grafana-logs", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                from: fromMs,
                to: toMs,
                target: "vfs-global-bot",
                query: email,
                cookie: sessionCookies[(start + i) % sessionCookies.length],
                ...(additionalFilter.trim() && { additionalFilter: additionalFilter.trim() }),
              }),
            }).then(async (r) => {
              const d = await r.json().catch(() => ({}));
              return r.ok && Array.isArray(d.logs)
                ? (d.logs as { time: string; line: string }[])
                : [];
            })
          )
        );
        for (const entries of results) allEntries.push(...entries);
      }
      setLoadingProgress("Computing identity & attempt stats…");
      const dbg: string[] = [];
      const metricsResult = computeMetricsFromDetailedLogs(
        allEntries,
        metricsDebugEnabled ? { debugLog: dbg } : undefined,
      );
      setReportMetrics(metricsResult?.metrics ?? null);
      setReportSortedLogs(metricsResult?.sortedLogs ?? []);
      setReportSessionTraces(metricsResult?.sessionTraces ?? {});
      setMetricsDebugText(metricsDebugEnabled ? dbg.join("\n") : "");
      setLoadingProgress(null);

      const allLines = allEntries.map((e) => e.line);
      setFaceErrors(aggregateFaceErrors(allLines));
      setPassportErrors(aggregatePassportErrors(allLines));

      const jobPrefixToMeta = extractSuccessJobIds(allLines);
      const failedJobPrefixToMeta = extractFailedJobIds(allLines);
      const prefixes = [...jobPrefixToMeta.keys()];
      const failedPrefixes = [...failedJobPrefixToMeta.keys()];
      const jobPrefixToLogs = new Map<string, { time: string; line: string }[]>();
      const failedJobPrefixToLogs = new Map<string, { time: string; line: string }[]>();

      for (let start = 0; start < prefixes.length; start += LIVENESS_BATCH) {
        const end = Math.min(start + LIVENESS_BATCH, prefixes.length);
        setLoadingProgress(
          `Fetching ${livenessTarget} logs (success) ${start + 1}-${end} of ${prefixes.length}…`
        );
        const batch = prefixes.slice(start, end);
        const results = await Promise.all(
          batch.map((prefix, i) =>
            fetch("/api/grafana-logs", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                from: fromMs,
                to: toMs,
                target: livenessTarget,
                query: `JOB_ID:${prefix}`,
                cookie: sessionCookies[(start + i) % sessionCookies.length],
              }),
            }).then(async (r) => {
              const d = await r.json().catch(() => ({}));
              return r.ok && Array.isArray(d.logs) ? (d.logs as { time: string; line: string }[]) : [];
            })
          )
        );
        batch.forEach((prefix, i) => {
          if (results[i].length > 0) jobPrefixToLogs.set(prefix, results[i]);
        });
      }
      for (let start = 0; start < failedPrefixes.length; start += LIVENESS_BATCH) {
        const end = Math.min(start + LIVENESS_BATCH, failedPrefixes.length);
        setLoadingProgress(
          `Fetching ${livenessTarget} logs (failed) ${start + 1}-${end} of ${failedPrefixes.length}…`
        );
        const batch = failedPrefixes.slice(start, end);
        const results = await Promise.all(
          batch.map((prefix, i) =>
            fetch("/api/grafana-logs", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                from: fromMs,
                to: toMs,
                target: livenessTarget,
                query: `JOB_ID:${prefix}`,
                cookie: sessionCookies[(start + i) % sessionCookies.length],
              }),
            }).then(async (r) => {
              const d = await r.json().catch(() => ({}));
              return r.ok && Array.isArray(d.logs) ? (d.logs as { time: string; line: string }[]) : [];
            })
          )
        );
        batch.forEach((prefix, i) => {
          if (results[i].length > 0) failedJobPrefixToLogs.set(prefix, results[i]);
        });
      }
      setLoadingProgress(null);
      const liveness = computeLivenessReport(jobPrefixToMeta, jobPrefixToLogs, failedJobPrefixToMeta, failedJobPrefixToLogs);
      setLivenessReport(liveness);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
      setLoadingProgress(null);
    } finally {
      setLoading(false);
    }
  }

  function renderSessionLogModal() {
    if (!sessionLogPopup) return null;
    const trace = reportSessionTraces[sessionLogPopup];
    const windowSlice =
      trace && reportSortedLogs.length > 0
        ? reportSortedLogs.slice(trace.startSortedIndex, trace.endSortedIndex + 1)
        : [];
    const slice = trace ? windowSlice.filter((e) => lineBelongsToSessionTrace(trace, e.line)) : windowSlice;
    const droppedOtherIdentity = trace ? windowSlice.length - slice.length : 0;
    const displaySlice = slice.filter((e) => !isSessionLogDebugLine(e.line));
    const q = sessionLogSearch.trim().toLowerCase();
    const filteredRows =
      q === ""
        ? displaySlice.map((e, idx) => ({ e, idx }))
        : displaySlice
            .map((e, idx) => ({ e, idx }))
            .filter(({ e }) => sessionLogSearchHaystack(e).includes(q));
    const filteredDisplaySlice = filteredRows.map((r) => r.e);
    const logText = filteredDisplaySlice
      .map(
        (e) =>
          `${formatLogTimeLocal(e.time)}\t${e.time}\t${stripSessionLogAnsi(e.line)}`,
      )
      .join("\n");
    const hiddenDebug = slice.length - displaySlice.length;
    return (
      <div
        className="fixed inset-0 z-[110] flex flex-col w-screen h-[100dvh] max-h-[100dvh] bg-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-log-title"
      >
        <div className="flex flex-col flex-1 min-h-0 w-full overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 shrink-0">
            <h2 id="session-log-title" className="text-sm font-semibold text-zinc-900 pr-2">
              Session log · {trace?.displayLabel ?? sessionLogPopup}
            </h2>
            <button
              type="button"
              onClick={() => setSessionLogPopup(null)}
              className="shrink-0 rounded-lg px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100"
            >
              Close
            </button>
          </div>
          {trace ? (
            <div className="px-4 py-2 border-b border-zinc-100 bg-zinc-50 text-xs space-y-1 shrink-0">
              <div>
                <span className="text-zinc-500">Session:</span>{" "}
                <code className="text-zinc-800">{trace.sessionKey}</code>
                {trace.closed ? (
                  <span className="ml-2 text-zinc-600">
                    · {trace.outcome === "success" ? "Completed" : "Failed"}
                    {trace.identityDurationSec != null && (
                      <span className="ml-1">· {fmt(trace.identityDurationSec)}s portal→end</span>
                    )}
                  </span>
                ) : (
                  <span className="ml-2 text-amber-700">· No identity end in range (open)</span>
                )}
              </div>
              <div className="tabular-nums">
                <span className="text-zinc-500">Counts:</span> faceAttempts={trace.faceAttempts}{" "}
                passportAttempts={trace.passportAttempts}
                <span className="text-zinc-500 ml-2">· Window</span> {trace.startSortedIndex}–{trace.endSortedIndex}
                {droppedOtherIdentity > 0 ? (
                  <span className="ml-1 text-zinc-600">
                    · {slice.length} for this identity ({droppedOtherIdentity} other filtered out)
                  </span>
                ) : (
                  <span className="ml-1">· {slice.length} for this identity</span>
                )}
                {hiddenDebug > 0 ? (
                  <span className="ml-1">
                    · {displaySlice.length} shown, {hiddenDebug} debug hidden
                  </span>
                ) : null}
              </div>
              {trace.urn && (
                <div className="break-all">
                  <span className="text-zinc-500">urn:</span> {trace.urn}
                </div>
              )}
            </div>
          ) : (
            <p className="px-4 py-2 text-xs text-amber-800 bg-amber-50 border-b border-amber-100">
              No trace for this session — regenerate the report.
            </p>
          )}
          <div className="shrink-0 px-4 py-2 border-b border-zinc-200 bg-white space-y-1">
            <p className="text-[11px] text-zinc-500">
              First column is <strong className="text-zinc-700">your local time</strong> (same idea as From/To). Grafana
              stores UTC — e.g. 9:16 PM Dubai = <code className="text-zinc-700">17:16Z</code>.
            </p>
            <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="session-log-search" className="text-xs font-medium text-zinc-600 shrink-0">
              Search
            </label>
            <input
              id="session-log-search"
              type="search"
              value={sessionLogSearch}
              onChange={(e) => setSessionLogSearch(e.target.value)}
              placeholder="Filter (local or UTC time + message)…"
              className="flex-1 min-w-[12rem] rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-400"
              autoComplete="off"
            />
            {q !== "" && (
              <span className="text-xs text-zinc-500 tabular-nums">
                {filteredDisplaySlice.length} / {displaySlice.length} lines
              </span>
            )}
            </div>
          </div>
          <div className="flex-1 min-h-0 p-3 flex flex-col">
            <pre className="text-[11px] leading-relaxed text-zinc-900 flex-1 min-h-0 overflow-auto whitespace-pre-wrap break-all font-mono bg-white border border-zinc-300 rounded-lg p-3 shadow-inner">
              {displaySlice.length > 0 ? (
                filteredRows.length > 0 ? (
                  filteredRows.map(({ e, idx }, i) => (
                    <Fragment key={idx}>
                      {i > 0 ? "\n" : null}
                      <SessionLogAnsiLine value={`${formatLogTimeLocal(e.time)}\t${e.line}`} />
                    </Fragment>
                  ))
                ) : (
                  "No lines match your search."
                )
              ) : slice.length > 0 ? (
                "All lines in this range were debug-level (hidden)."
              ) : (
                "No log lines in slice."
              )}
            </pre>
          </div>
          <div className="border-t border-zinc-200 px-4 py-2 shrink-0 flex justify-end">
            <button
              type="button"
              className="text-xs rounded-lg border border-zinc-300 px-3 py-1.5 text-zinc-700 hover:bg-zinc-100"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(logText);
                } catch {
                  /* ignore */
                }
              }}
            >
              Copy logs
            </button>
            <span className="text-[11px] text-zinc-500 ml-2">
              TSV: local time, UTC ISO, line
            </span>
          </div>
        </div>
      </div>
    );
  }

  const browserTz =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Prod report</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Set time range and generate the report. Metrics are built from Grafana/Loki (vfs-global-bot).
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">From</label>
          <input
            type="datetime-local"
            value={fromStr}
            onChange={(e) => setFromStr(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">To</label>
          <input
            type="datetime-local"
            value={toStr}
            onChange={(e) => setToStr(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
        </div>
        <div className="sm:col-span-2 flex flex-col justify-end">
          <p className="text-xs text-zinc-500 mb-2 leading-snug">
            From/To use your computer&apos;s local timezone
            {browserTz ? (
              <>
                : <code className="text-zinc-700">{browserTz}</code>
              </>
            ) : null}
            . Loki returns UTC; session log shows local time in the first column.
          </p>
          <label className="block text-sm font-medium text-zinc-700 mb-1">Quick range</label>
          <div className="flex gap-2 flex-wrap">
            {(["15m", "1h", "6h", "24h"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => applyPreset(v)}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                Last {v}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">Liveness app (for JOB_ID logs)</label>
          <select
            value={livenessTarget}
            onChange={(e) =>
              setLivenessTarget(
                e.target.value === "aws-liveness-automation-staging"
                  ? "aws-liveness-automation-staging"
                  : "liveness-bot"
              )
            }
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          >
            <option value="liveness-bot">liveness-bot</option>
            <option value="aws-liveness-automation-staging">aws-liveness-automation-staging</option>
          </select>
          <p className="mt-1 text-xs text-zinc-500">
            Used only when fetching JOB_ID-based liveness logs (video solver metrics).
          </p>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-700 mb-1">Additional filter (optional)</label>
        <input
          type="text"
          value={additionalFilter}
          onChange={(e) => setAdditionalFilter(e.target.value)}
          placeholder="e.g. fromCountry=ago toCountry=prt or Face ver"
          className="w-full max-w-xl rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
        />
        <p className="mt-1 text-xs text-zinc-500">Applied to identity verification and per-email (vfs-global-bot) only.</p>
      </div>

     

      {metricsDebugText.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3">
          <div className="text-xs font-medium text-amber-900 mb-1">
            Metrics debug trace (portal / face lines / session close / reconcile)
          </div>
          <pre className="text-[10px] leading-snug text-zinc-800 max-h-96 overflow-auto whitespace-pre-wrap break-all font-mono">
            {metricsDebugText}
          </pre>
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {reportMetrics !== null && (
        <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
          <h2 className="text-sm font-semibold text-zinc-900 px-4 py-2 border-b border-zinc-200 bg-zinc-50">
            Report <span className="font-normal text-zinc-500">· {reportMetrics.count} identities</span>
          </h2>
          <div className="px-4 py-3 space-y-4">
            <section>
              <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Attempts</h3>
              <ul className="space-y-1.5 text-sm">
                <li className="flex justify-between gap-4">
                  <span className="text-zinc-700">Total face verification attempts</span>
                  <span className="font-medium tabular-nums">{reportMetrics.totalFaceAttempts}</span>
                </li>
                <li className="flex justify-between gap-4">
                  <span className="text-zinc-700">Face verification — failed</span>
                  <span className="font-medium tabular-nums text-amber-700">{reportMetrics.faceFailed}</span>
                </li>
                <li className="flex justify-between gap-4">
                  <span className="text-zinc-700">Face verification — success</span>
                  <span className="font-medium tabular-nums text-emerald-700">{reportMetrics.faceSuccess}</span>
                </li>
                <li className="flex justify-between gap-4">
                  <span className="text-zinc-700">Total passport verification attempts</span>
                  <span className="font-medium tabular-nums">{reportMetrics.totalPassportAttempts}</span>
                </li>
                <li className="flex justify-between gap-4">
                  <span className="text-zinc-700">Passport verification — failed</span>
                  <span className="font-medium tabular-nums text-amber-700">{reportMetrics.passportFailed}</span>
                </li>
                <li className="flex justify-between gap-4">
                  <span className="text-zinc-700">Passport verification — success</span>
                  <span className="font-medium tabular-nums text-emerald-700">{reportMetrics.passportSuccess}</span>
                </li>
              </ul>
            </section>
            <section>
              <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Average times (s) · per attempt except total (per verification)</h3>
              <ul className="space-y-1.5 text-sm">
                <li className="flex justify-between gap-4">
                  <span className="text-zinc-700">Identity verification (total)</span>
                  <span className="font-medium tabular-nums">
                    {fmt(reportMetrics.avgTotalTime)}s
                  </span>
                </li>
                <li className="flex justify-between gap-4">
                  <span className="text-zinc-700">Face verification</span>
                  <span className="font-medium tabular-nums">
                    {fmt(reportMetrics.avgFaceTime)}s
                  </span>
                </li>
                <li className="flex justify-between gap-4">
                  <span className="text-zinc-700">Face verification — SessionInit</span>
                  <span className="font-medium tabular-nums">
                    {fmt(reportMetrics.avgFaceSessionInit)}s
                  </span>
                </li>
                <li>
                  <div className="text-xs text-zinc-500 mt-2 mb-1">
                    Face attempts distribution — click a row, then a session for logs (portal → identity end)
                  </div>
                  {reportMetrics.faceAttemptsDistribution.some((r) => r.identities > 0) ? (
                    <div className="space-y-0.5">
                      {reportMetrics.faceAttemptsDistribution
                        .filter((r) => r.identities > 0)
                        .map((r) => (
                          <button
                            key={r.attempts}
                            type="button"
                            onClick={() =>
                              setIdentityPopup({
                                title: `Face · ${r.attempts} attempt${r.attempts === 1 ? "" : "s"} · ${r.identities} session${r.identities === 1 ? "" : "s"}`,
                                sessions: r.sessions,
                              })
                            }
                            className="block w-full text-left rounded-md px-2 py-1 -mx-2 text-sm text-zinc-800 hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-400"
                          >
                            <span className="tabular-nums">{r.attempts}</span> attempts:{" "}
                            <span className="tabular-nums">{r.identities}</span> identities
                          </button>
                        ))}
                    </div>
                  ) : (
                    <div className="text-xs text-zinc-500">No face attempt data in this range.</div>
                  )}
                </li>
                <li className="flex justify-between gap-4">
                  <span className="text-zinc-700">Face verification — Solve</span>
                  <span className="font-medium tabular-nums">
                    {fmt(reportMetrics.avgFaceSolve)}s
                  </span>
                </li>
                <li className="flex justify-between gap-4">
                  <span className="text-zinc-700">Face verification — GetResult</span>
                  <span className="font-medium tabular-nums">
                    {fmt(reportMetrics.avgFaceGetResult)}s
                  </span>
                </li>
                <li className="flex justify-between gap-4">
                  <span className="text-zinc-700">Face validation</span>
                  <span className="font-medium tabular-nums">
                    {fmt(reportMetrics.avgFaceValidationTime)}s
                  </span>
                </li>
                <li className="flex justify-between gap-4">
                  <span className="text-zinc-700">Passport verification</span>
                  <span className="font-medium tabular-nums">
                    {fmt(reportMetrics.avgPassportTime)}s
                  </span>
                </li>
                <li>
                  <div className="text-xs text-zinc-500 mt-2 mb-1">
                    Passport attempts distribution — click a row, then a session for logs (portal → identity end)
                  </div>
                  {reportMetrics.passportAttemptsDistribution.some((r) => r.identities > 0) ? (
                    <div className="space-y-0.5">
                      {reportMetrics.passportAttemptsDistribution
                        .filter((r) => r.identities > 0)
                        .map((r) => (
                          <button
                            key={r.attempts}
                            type="button"
                            onClick={() =>
                              setIdentityPopup({
                                title: `Passport · ${r.attempts} attempt${r.attempts === 1 ? "" : "s"} · ${r.identities} session${r.identities === 1 ? "" : "s"}`,
                                sessions: r.sessions,
                              })
                            }
                            className="block w-full text-left rounded-md px-2 py-1 -mx-2 text-sm text-zinc-800 hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-400"
                          >
                            <span className="tabular-nums">{r.attempts}</span> attempts:{" "}
                            <span className="tabular-nums">{r.identities}</span> identities
                          </button>
                        ))}
                    </div>
                  ) : (
                    <div className="text-xs text-zinc-500">No passport attempt data in this range.</div>
                  )}
                </li>
                <li>
                  <button
                    type="button"
                    disabled={reportMetrics.passportSlowerThanFace <= 0}
                    onClick={() =>
                      setIdentityPopup({
                        title: `Passport slower than face · ${reportMetrics.passportSlowerThanFace} paired attempt${reportMetrics.passportSlowerThanFace === 1 ? "" : "s"}`,
                        sessions: reportMetrics.passportSlowerThanFaceSessions,
                        hint:
                          "Each row is one paired attempt (same index: 1st face duration vs 1st passport duration in that identity session). Click a row for full session logs.",
                      })
                    }
                    className="flex w-full justify-between gap-4 text-left text-xs text-zinc-600 rounded-md px-2 py-1.5 -mx-2 hover:bg-zinc-100 disabled:opacity-50 disabled:hover:bg-transparent focus:outline-none focus:ring-2 focus:ring-zinc-400"
                  >
                    <span>Attempts where passport verification took longer than face verification</span>
                    <span className="font-medium tabular-nums text-zinc-800 shrink-0">
                      {reportMetrics.passportSlowerThanFace}
                    </span>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    disabled={reportMetrics.faceSlowerThanPassport <= 0}
                    onClick={() =>
                      setIdentityPopup({
                        title: `Face slower than passport · ${reportMetrics.faceSlowerThanPassport} paired attempt${reportMetrics.faceSlowerThanPassport === 1 ? "" : "s"}`,
                        sessions: reportMetrics.faceSlowerThanPassportSessions,
                        hint:
                          "Each row is one paired attempt (same index: 1st face duration vs 1st passport duration in that identity session). Click a row for full session logs.",
                      })
                    }
                    className="flex w-full justify-between gap-4 text-left text-xs text-zinc-600 rounded-md px-2 py-1.5 -mx-2 hover:bg-zinc-100 disabled:opacity-50 disabled:hover:bg-transparent focus:outline-none focus:ring-2 focus:ring-zinc-400"
                  >
                    <span>Attempts where face verification took longer than passport verification</span>
                    <span className="font-medium tabular-nums text-zinc-800 shrink-0">
                      {reportMetrics.faceSlowerThanPassport}
                    </span>
                  </button>
                </li>
              </ul>
            </section>
            {livenessReport !== null && (
              <>
                {livenessReport.success && livenessReport.success.jobCount > 0 && (
                  <section>
                    <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Liveness job metrics (success) · {livenessReport.success.jobCount} jobs</h3>
                    <LivenessSectionBlock section={livenessReport.success} fmt={fmt} />
                  </section>
                )}
                {livenessReport.failed && livenessReport.failed.jobCount > 0 && (
                  <section>
                    <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Liveness job metrics (failed) · {livenessReport.failed.jobCount} jobs</h3>
                    <LivenessSectionBlock section={livenessReport.failed} fmt={fmt} />
                  </section>
                )}
              </>
            )}
            {faceErrors.length > 0 && (
              <section>
                <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Face verification errors</h3>
                <ul className="space-y-3 text-sm">
                  {faceErrors.map((entry, i) => (
                    <li key={i} className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                      <div className="font-medium text-amber-900">{entry.key}</div>
                      <div className="mt-1 text-zinc-600">Count: <span className="tabular-nums font-medium">{entry.count}</span></div>
                      {entry.videoUrl && (
                        <div className="mt-1 truncate">
                          <span className="text-zinc-500">Video:</span>{" "}
                          <a href={entry.videoUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline break-all">{entry.videoUrl}</a>
                        </div>
                      )}
                      {entry.sessionId && (
                        <div className="mt-0.5 text-zinc-600"><span className="text-zinc-500">Session ID:</span> <code className="text-xs">{entry.sessionId}</code></div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {passportErrors.length > 0 && (
              <section>
                <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Passport validation errors</h3>
                <ul className="space-y-3 text-sm">
                  {passportErrors.map((entry, i) => (
                    <li key={i} className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                      <div className="font-medium text-amber-900">{entry.key}</div>
                      <div className="mt-1 text-zinc-600">Count: <span className="tabular-nums font-medium">{entry.count}</span></div>
                      {entry.imageUrl && (
                        <div className="mt-1 truncate">
                          <span className="text-zinc-500">Image:</span>{" "}
                          <a href={entry.imageUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline break-all">{entry.imageUrl}</a>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      )}

      {identityPopup && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40"
          role="dialog"
          aria-modal="true"
          aria-labelledby="identity-popup-title"
          onClick={() => setIdentityPopup(null)}
        >
          <div
            className="max-h-[min(80vh,520px)] w-full max-w-lg overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3">
              <h2
                id="identity-popup-title"
                className="text-sm font-semibold text-zinc-900 pr-2"
              >
                {identityPopup.title}
              </h2>
              <button
                type="button"
                onClick={() => setIdentityPopup(null)}
                className="shrink-0 rounded-lg px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100"
              >
                Close
              </button>
            </div>
            <div className="max-h-[min(60vh,420px)] overflow-y-auto px-4 py-3">
              <p className="text-xs text-zinc-500 mb-2">
                {identityPopup.hint ??
                  "Click a session to see stats and all vfs-global-bot lines from portal start through identity completed/failed (same sorted order as the report)."}
              </p>
              <ul className="space-y-2 text-sm text-zinc-800">
                {identityPopup.sessions.map((s) => (
                  <li
                    key={`${s.sessionKey}-${s.attemptPairIndex ?? 0}-${s.displayLabel}`}
                    className="border-b border-zinc-100 pb-2 last:border-0"
                  >
                    <button
                      type="button"
                      className="w-full text-left rounded-md px-2 py-1.5 -mx-2 hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-400"
                      onClick={() => {
                        setIdentityPopup(null);
                        setSessionLogPopup(s.sessionKey);
                      }}
                    >
                      <span className="break-all font-medium text-zinc-900">{s.displayLabel}</span>
                      {s.faceSec != null && s.passportSec != null && (
                        <span className="block text-xs text-zinc-600 tabular-nums mt-1">
                          Face {fmt(s.faceSec)}s · Passport {fmt(s.passportSec)}s
                          {s.attemptPairIndex != null && (
                            <span className="text-zinc-500"> · paired attempt #{s.attemptPairIndex}</span>
                          )}
                        </span>
                      )}
                      <span className="block text-[10px] text-zinc-500 font-mono mt-0.5">{s.sessionKey}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {renderSessionLogModal()}
    </div>
  );
}
