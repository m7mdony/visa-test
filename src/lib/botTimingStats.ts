import { computeTimingAnalytics, type TimingAnalytics } from "@/lib/timingAnalytics";

export type InHouseVerificationEntry = {
  totalSolveTimeMs: number;
  bottleneckTimeMs: number;
};

export type BottleneckStats = {
  zeroCount: number;
  nonZeroCount: number;
  nonZero: TimingAnalytics | null;
};

export type AttemptPassedTimingBreakdown = {
  /** `[WASM] Pool job done in …s` — actual WASM solve time. */
  wasmSolve: TimingAnalytics | null;
  /** `[SINGLEMODAL] … done in …s total` — actual Azure POST timing (incl. retries). */
  singleModel: TimingAnalytics | null;
  /** Prefer `singleModel.avg`; fallback = `Attempt … passed` avg − WASM solve avg. */
  singleModelOverheadAvgMs: number | null;
  wasmLogLineCount: number;
  singleModelLogLineCount: number;
};

export type BotTimingReport = {
  attemptPassed: {
    logLineCount: number;
    overall: TimingAnalytics | null;
    breakdown: AttemptPassedTimingBreakdown | null;
  };
  inHouseVerification: {
    logLineCount: number;
    parsedCount: number;
    totalSolveTime: TimingAnalytics | null;
    bottleneck: BottleneckStats;
  };
};

/** `Attempt 2: passed (1247ms)` or legacy `Attempt 2/3: passed (1247ms)` */
const ATTEMPT_PASSED_MS_RE = /Attempt\s+\d+(?:\/\d+)?\s*:\s*passed\s*\(\s*(\d+)\s*ms\s*\)/i;

/** `[TimeTaken=8605ms, BottleneckTime=0ms]` or `[TotalSolveTime=5821ms, BottleneckTime=0ms]` */
const IN_HOUSE_RE =
  /in-house verification passed\s*\[(?:TimeTaken|TotalSolveTime)=(\d+)ms,\s*BottleneckTime=(\d+)ms\]/i;

/** Legacy `… [solves=2/3, TotalSolveTime=…, BottleneckTime=…]` */
const IN_HOUSE_LEGACY_RE =
  /in-house verification passed\s*\[solves=\d+\/\d+,\s*(?:TimeTaken|TotalSolveTime)=(\d+)ms,\s*BottleneckTime=(\d+)ms\]/i;

/** `[WASM] Pool job done in 3.77s` */
const WASM_POOL_JOB_DONE_RE = /\[WASM\]\s*Pool job done in\s+([\d.]+)\s*s\b/i;

/** `[SINGLEMODAL] ecaf13e3 done in 4.43s total` */
const SINGLEMODAL_DONE_RE = /\[SINGLEMODAL\][^\n]*\bdone in\s+([\d.]+)\s*s\s+total\b/i;

export function isAttemptPassedTimingLine(line: string): boolean {
  return ATTEMPT_PASSED_MS_RE.test(line);
}

export function parseAttemptPassedMs(line: string): number | null {
  const m = line.match(ATTEMPT_PASSED_MS_RE);
  if (!m?.[1]) return null;
  const ms = parseInt(m[1], 10);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms;
}

export function parseInHouseVerificationEntry(line: string): InHouseVerificationEntry | null {
  const m = line.match(IN_HOUSE_RE) ?? line.match(IN_HOUSE_LEGACY_RE);
  if (!m?.[1] || !m[2]) return null;
  const totalSolveTimeMs = parseInt(m[1], 10);
  const bottleneckTimeMs = parseInt(m[2], 10);
  if (!Number.isFinite(totalSolveTimeMs) || !Number.isFinite(bottleneckTimeMs)) {
    return null;
  }
  return { totalSolveTimeMs, bottleneckTimeMs };
}

export function parseInHouseVerificationTotalMs(line: string): number | null {
  const entry = parseInHouseVerificationEntry(line);
  return entry?.totalSolveTimeMs ?? null;
}

export function isWasmPoolJobDoneLine(line: string): boolean {
  return WASM_POOL_JOB_DONE_RE.test(line);
}

export function parseWasmPoolJobDoneMs(line: string): number | null {
  const m = line.match(WASM_POOL_JOB_DONE_RE);
  if (!m?.[1]) return null;
  const seconds = parseFloat(m[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

export function isSingleModalDoneLine(line: string): boolean {
  return SINGLEMODAL_DONE_RE.test(line);
}

export function parseSingleModalDoneMs(line: string): number | null {
  const m = line.match(SINGLEMODAL_DONE_RE);
  if (!m?.[1]) return null;
  const seconds = parseFloat(m[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

function buildAttemptPassedBreakdown(
  attemptOverall: TimingAnalytics | null,
  wasmLines: string[],
  singleModalLines: string[]
): AttemptPassedTimingBreakdown | null {
  const wasmMs: number[] = [];
  for (const line of wasmLines) {
    const ms = parseWasmPoolJobDoneMs(line);
    if (ms != null) wasmMs.push(ms);
  }
  const singleModalMs: number[] = [];
  for (const line of singleModalLines) {
    const ms = parseSingleModalDoneMs(line);
    if (ms != null) singleModalMs.push(ms);
  }
  const wasmSolve = computeTimingAnalytics(wasmMs);
  const singleModel = computeTimingAnalytics(singleModalMs);
  if (!attemptOverall && !wasmSolve && !singleModel) return null;

  let singleModelOverheadAvgMs: number | null = null;
  if (singleModel?.avg != null) {
    singleModelOverheadAvgMs = singleModel.avg;
  } else if (attemptOverall?.avg != null && wasmSolve?.avg != null) {
    singleModelOverheadAvgMs = Math.max(0, attemptOverall.avg - wasmSolve.avg);
  }

  return {
    wasmSolve,
    singleModel,
    singleModelOverheadAvgMs,
    wasmLogLineCount: wasmLines.length,
    singleModelLogLineCount: singleModalLines.length,
  };
}

export function buildBotTimingReport(
  attemptLines: string[],
  inHouseLines: string[],
  wasmPoolJobDoneLines: string[] = [],
  singleModalDoneLines: string[] = []
): BotTimingReport {
  const attemptMs: number[] = [];
  for (const line of attemptLines) {
    const ms = parseAttemptPassedMs(line);
    if (ms != null) attemptMs.push(ms);
  }

  const inHouseEntries: InHouseVerificationEntry[] = [];
  for (const line of inHouseLines) {
    const parsed = parseInHouseVerificationEntry(line);
    if (parsed) inHouseEntries.push(parsed);
  }

  const bottleneckNonZero = inHouseEntries
    .map((e) => e.bottleneckTimeMs)
    .filter((ms) => ms > 0);
  const zeroCount = inHouseEntries.filter((e) => e.bottleneckTimeMs === 0).length;

  const attemptOverall = computeTimingAnalytics(attemptMs);

  return {
    attemptPassed: {
      logLineCount: attemptLines.length,
      overall: attemptOverall,
      breakdown: buildAttemptPassedBreakdown(attemptOverall, wasmPoolJobDoneLines, singleModalDoneLines),
    },
    inHouseVerification: {
      logLineCount: inHouseLines.length,
      parsedCount: inHouseEntries.length,
      totalSolveTime: computeTimingAnalytics(inHouseEntries.map((e) => e.totalSolveTimeMs)),
      bottleneck: {
        zeroCount,
        nonZeroCount: bottleneckNonZero.length,
        nonZero: computeTimingAnalytics(bottleneckNonZero),
      },
    },
  };
}
