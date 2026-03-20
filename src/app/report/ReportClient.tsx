"use client";

import { useState, useCallback } from "react";

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
  faceAttemptsDistribution: Array<{ attempts: number; identities: number }>;
  passportAttemptsDistribution: Array<{ attempts: number; identities: number }>;
  passportSlowerThanFace: number;
  faceSlowerThanPassport: number;
};

type LogEntry = { time: string; line: string };

function computeMetricsFromDetailedLogs(entries: LogEntry[]): ReportMetrics | null {
  if (entries.length === 0) return null;

  // Ensure chronological order so start/end pairing works
  const sorted = [...entries].sort((a, b) => a.time.localeCompare(b.time));

  // Attempts/success/failure (used for the "Attempts" section)
  let totalFaceAttempts = 0;
  let faceSuccess = 0;
  let faceFailed = 0;
  let totalPassportAttempts = 0;
  let passportSuccess = 0;
  let passportFailed = 0;

  // Identity-level stacks for total identity time and passport time
  const identityStartStacks = new Map<string, number[]>();
  const passportStartStacks = new Map<string, number[]>();

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

  // For attempt-count distributions and face/passport comparison per identity
  const identityAttemptStats = new Map<
    string,
    { faceAttempts: number; passportAttempts: number; faceTimes: number[]; passportTimes: number[] }
  >();

  // Pair `FaceValidation=...` timings onto the corresponding face verification attempt times.
  // - If validation is on a different log line than the face attempt, queue it (FIFO) and attach later.
  // - If validation is already on the same face attempt log line, attach immediately.
  const unassignedFaceAttemptIndicesByIdentity = new Map<string, number[]>();
  const pendingFaceValidationTimesByIdentity = new Map<string, number[]>();

  const getIdentityAttempts = (key: string) => {
    let cur = identityAttemptStats.get(key);
    if (!cur) {
      cur = { faceAttempts: 0, passportAttempts: 0, faceTimes: [], passportTimes: [] };
      identityAttemptStats.set(key, cur);
    }
    return cur;
  };

  for (const { time, line } of sorted) {
    const urnMatch = line.match(/\burn=([^\s]+)/);
    const urn = urnMatch?.[1]?.trim();
    const emailMatch = line.match(/email=([^\s]+)/);
    const email = emailMatch?.[1]?.trim();
    const identityKey = urn ?? email ?? "";

    const tsMs = Number.isFinite(Date.parse(time)) ? Date.parse(time) : NaN;

    // Used to prevent double-adding the same FaceValidation=... value to face verification time.
    let faceValidationAlreadyAddedToFaceTimeOnThisIteration = false;

    // Identity total time: Initiating identity portal -> completed/failed for same identity
    if (identityKey && line.includes("Initiating identity verification portal")) {
      if (!Number.isNaN(tsMs)) {
        const stack = identityStartStacks.get(identityKey) ?? [];
        stack.push(tsMs);
        identityStartStacks.set(identityKey, stack);
      }
    } else if (
      identityKey &&
      (line.includes("Identity verification completed successfully") ||
        line.includes("Identity verification failed"))
    ) {
      const stack = identityStartStacks.get(identityKey);
      if (stack && stack.length > 0 && !Number.isNaN(tsMs)) {
        const startMs = stack.shift()!;
        const diffSec = Math.max(0, (tsMs - startMs) / 1000);
        identityCountForTiming += 1;
        sumIdentityTotalTime += diffSec;
        identityStartStacks.set(identityKey, stack);
      }
    }

    // Face verification attempts (success + failed), ignore helper "[VerifyJob]" logs
    if (
      line.includes("Face verification") &&
      !line.includes("[VerifyJob] - Face verification completed successfully")
    ) {
      const isSuccess = line.includes("Face verification completed successfully");
      const isFailed = line.includes("Face verification failed");
      if (isSuccess || isFailed) {
        if (isFailed && isTlsRelated(line)) {
          continue;
        }
        totalFaceAttempts += 1;
        if (isSuccess) faceSuccess += 1;
        if (isFailed) faceFailed += 1;

        if (identityKey) {
          const s = getIdentityAttempts(identityKey);
          s.faceAttempts += 1;
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
          } else if (identityKey) {
            // Otherwise, if we already saw FaceValidation for this identity earlier, attach from the pending queue.
            const pending = pendingFaceValidationTimesByIdentity.get(identityKey);
            if (pending && pending.length > 0) {
              const pendingFval = pending.shift()!;
              v += pendingFval;
              usedFaceValidation = true;
              if (pending.length === 0) pendingFaceValidationTimesByIdentity.delete(identityKey);
            }
          }

          sumFaceTime += v;
          faceTimeCount += 1;
          if (identityKey) {
            const s = getIdentityAttempts(identityKey);
            const faceIdx = s.faceTimes.length;
            s.faceTimes.push(v);

            // If FaceValidation wasn't attached yet, queue this attempt index for a future FaceValidation=... line.
            if (!usedFaceValidation) {
              const q = unassignedFaceAttemptIndicesByIdentity.get(identityKey) ?? [];
              q.push(faceIdx);
              unassignedFaceAttemptIndicesByIdentity.set(identityKey, q);
            }
          }
        }
      }
    }

    // Passport validation attempts and timings
    if (identityKey && line.includes("Initiating passport validation")) {
      if (!Number.isNaN(tsMs)) {
        const stack = passportStartStacks.get(identityKey) ?? [];
        stack.push(tsMs);
        passportStartStacks.set(identityKey, stack);
      }
    } else if (
      identityKey &&
      (line.includes("Passport validation completed successfully") ||
        line.includes("Passport validation failed"))
    ) {
      if (line.includes("Passport validation failed") && isTlsRelated(line)) {
        continue;
      }
      // Count attempts
      totalPassportAttempts += 1;
      if (identityKey) {
        const s = getIdentityAttempts(identityKey);
        s.passportAttempts += 1;
      }
      if (line.includes("Passport validation completed successfully")) {
        passportSuccess += 1;
      } else if (line.includes("Passport validation failed")) {
        passportFailed += 1;
      }

      // Compute duration from last unmatched "Initiating passport validation" for this identity
      const stack = passportStartStacks.get(identityKey);
      if (stack && stack.length > 0 && !Number.isNaN(tsMs)) {
        const startMs = stack.shift()!;
        const diffSec = Math.max(0, (tsMs - startMs) / 1000);
        sumPassportTime += diffSec;
        passportTimeCount += 1;
        passportStartStacks.set(identityKey, stack);
        if (identityKey) {
          getIdentityAttempts(identityKey).passportTimes.push(diffSec);
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
        if (identityKey) {
          const q = unassignedFaceAttemptIndicesByIdentity.get(identityKey);
          if (q && q.length > 0) {
            const faceIdx = q.shift()!;
            if (q.length === 0) unassignedFaceAttemptIndicesByIdentity.delete(identityKey);

            const s = identityAttemptStats.get(identityKey);
            if (s && Number.isFinite(s.faceTimes[faceIdx])) {
              s.faceTimes[faceIdx] += fval;
              sumFaceTime += fval;
            }
          } else {
            const pending = pendingFaceValidationTimesByIdentity.get(identityKey) ?? [];
            pending.push(fval);
            pendingFaceValidationTimesByIdentity.set(identityKey, pending);
          }
        }
      }
    }
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

  // Build attempt-count histograms per identity
  const buildDistribution = (values: number[]): Array<{ attempts: number; identities: number }> => {
    const nonZero = values.filter((v) => v > 0);
    if (nonZero.length === 0) return [];
    const max = Math.max(...nonZero);
    const hist = new Map<number, number>();
    for (const v of nonZero) {
      hist.set(v, (hist.get(v) ?? 0) + 1);
    }
    const out: Array<{ attempts: number; identities: number }> = [];
    for (let a = 1; a <= max; a++) {
      const identities = hist.get(a) ?? 0;
      if (identities > 0) out.push({ attempts: a, identities });
    }
    return out;
  };

  const faceAttemptsDistribution = buildDistribution(
    [...identityAttemptStats.values()].map((s) => s.faceAttempts)
  );
  const passportAttemptsDistribution = buildDistribution(
    [...identityAttemptStats.values()].map((s) => s.passportAttempts)
  );

  // Compare per-identity paired face/passport attempt durations
  let passportSlowerThanFace = 0;
  let faceSlowerThanPassport = 0;
  for (const s of identityAttemptStats.values()) {
    const n = Math.min(s.faceTimes.length, s.passportTimes.length);
    for (let i = 0; i < n; i++) {
      const f = s.faceTimes[i];
      const p = s.passportTimes[i];
      if (!Number.isFinite(f) || !Number.isFinite(p)) continue;
      if (p > f) passportSlowerThanFace += 1;
      else if (f > p) faceSlowerThanPassport += 1;
    }
  }

  return {
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
  };
}


function fmt(s: number): string {
  return Number.isFinite(s) ? s.toFixed(2) : "—";
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
  shortWebsocketCount: number;
  shortWebsocketExamples: Array<{ jobId: string; videoUrl: string }>;
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
  const shortWebsocket: Array<{ fullJobId: string; videoUrl: string; ws: number }> = [];
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
    if (m.websocketDisconnect != null && m.websocketDisconnect < 10) {
      shortWebsocket.push({ ...meta, ws: m.websocketDisconnect });
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
    shortWebsocketExamples: shortWebsocket.slice(0, 3).map(({ fullJobId, videoUrl }) => ({ jobId: fullJobId, videoUrl })),
    shortWebsocketCount: shortWebsocket.length,
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
      {section.shortWebsocketCount > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 mt-2">
          <div className="text-sm font-medium text-zinc-800">Jobs with websocket &lt; 10s: {section.shortWebsocketCount}</div>
          <div className="mt-2 text-xs space-y-2">
            {section.shortWebsocketExamples.map((ex, i) => (
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

  const applyPreset = useCallback((interval: string) => {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["24h"];
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    setFromStr(toDatetimeLocal(from));
    setToStr(toDatetimeLocal(to));
  }, []);

  async function handleGenerate() {
    setError(null);
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
      const metrics = computeMetricsFromDetailedLogs(allEntries);
      setReportMetrics(metrics ?? null);
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

      <button
        type="button"
        onClick={handleGenerate}
        disabled={loading}
        className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {loading ? (loadingProgress ?? "Generating…") : "Generate report"}
      </button>

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
                  <div className="text-xs text-zinc-500 mt-2 mb-1">Face attempts distribution (per identity)</div>
                  {reportMetrics.faceAttemptsDistribution.some((r) => r.identities > 0) ? (
                    <div className="space-y-0.5">
                      {reportMetrics.faceAttemptsDistribution
                        .filter((r) => r.identities > 0)
                        .map((r) => (
                          <div key={r.attempts}>
                            <span className="tabular-nums">{r.attempts}</span> attempts:{" "}
                            <span className="tabular-nums">{r.identities}</span> identities
                          </div>
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
                  <div className="text-xs text-zinc-500 mt-2 mb-1">Passport attempts distribution (per identity)</div>
                  {reportMetrics.passportAttemptsDistribution.some((r) => r.identities > 0) ? (
                    <div className="space-y-0.5">
                      {reportMetrics.passportAttemptsDistribution
                        .filter((r) => r.identities > 0)
                        .map((r) => (
                          <div key={r.attempts}>
                            <span className="tabular-nums">{r.attempts}</span> attempts:{" "}
                            <span className="tabular-nums">{r.identities}</span> identities
                          </div>
                        ))}
                    </div>
                  ) : (
                    <div className="text-xs text-zinc-500">No passport attempt data in this range.</div>
                  )}
                </li>
                <li className="flex justify-between gap-4 text-xs text-zinc-600">
                  <span>Attempts where passport verification took longer than face verification</span>
                  <span className="font-medium tabular-nums text-zinc-800">
                    {reportMetrics.passportSlowerThanFace}
                  </span>
                </li>
                <li className="flex justify-between gap-4 text-xs text-zinc-600">
                  <span>Attempts where face verification took longer than passport verification</span>
                  <span className="font-medium tabular-nums text-zinc-800">
                    {reportMetrics.faceSlowerThanPassport}
                  </span>
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
    </div>
  );
}
