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

export type BotTimingReport = {
  attemptPassed: {
    logLineCount: number;
    overall: TimingAnalytics | null;
  };
  inHouseVerification: {
    logLineCount: number;
    parsedCount: number;
    totalSolveTime: TimingAnalytics | null;
    bottleneck: BottleneckStats;
  };
};

/** `Attempt 2: passed (1247ms)` or legacy `Attempt 2/3: passed (1247ms)` */
const ATTEMPT_PASSED_MS_RE = /Attempt\s+\d+(?:\/\d+)?\s*:\s*passed\s*\((\d+)ms\)/i;

/** `In-house verification passed [TotalSolveTime=5821ms, BottleneckTime=0ms]` */
const IN_HOUSE_RE =
  /in-house verification passed\s*\[TotalSolveTime=(\d+)ms,\s*BottleneckTime=(\d+)ms\]/i;

/** Legacy `… [solves=2/3, TotalSolveTime=…, BottleneckTime=…]` */
const IN_HOUSE_LEGACY_RE =
  /in-house verification passed\s*\[solves=\d+\/\d+,\s*TotalSolveTime=(\d+)ms,\s*BottleneckTime=(\d+)ms\]/i;

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

export function buildBotTimingReport(
  attemptLines: string[],
  inHouseLines: string[]
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

  return {
    attemptPassed: {
      logLineCount: attemptLines.length,
      overall: computeTimingAnalytics(attemptMs),
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
