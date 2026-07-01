import { computeTimingAnalytics, type TimingAnalytics } from "@/lib/timingAnalytics";

export type InHouseVerificationEntry = {
  solves: number;
  maxSolves: number;
  totalSolveTimeMs: number;
  bottleneckTimeMs: number;
};

export type SolveTryDistribution = {
  firstTry: number;
  secondTry: number;
  thirdTry: number;
  other: number;
  total: number;
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
    solveTryDistribution: SolveTryDistribution;
    totalSolveTime: TimingAnalytics | null;
    bottleneck: BottleneckStats;
  };
};

/** `Attempt 2: passed (1247ms)` or legacy `Attempt 2/3: passed (1247ms)` */
const ATTEMPT_PASSED_MS_RE = /Attempt\s+\d+(?:\/\d+)?\s*:\s*passed\s*\((\d+)ms\)/i;

export function isAttemptPassedTimingLine(line: string): boolean {
  return ATTEMPT_PASSED_MS_RE.test(line);
}
const IN_HOUSE_NEW_RE =
  /in-house verification passed\s*\[solves=(\d+)\/(\d+),\s*TotalSolveTime=(\d+)ms,\s*BottleneckTime=(\d+)ms\]/i;

export function parseAttemptPassedMs(line: string): number | null {
  const m = line.match(ATTEMPT_PASSED_MS_RE);
  if (!m?.[1]) return null;
  const ms = parseInt(m[1], 10);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms;
}

export function parseInHouseVerificationEntry(line: string): InHouseVerificationEntry | null {
  const m = line.match(IN_HOUSE_NEW_RE);
  if (!m?.[1] || !m[2] || !m[3] || !m[4]) return null;
  const solves = parseInt(m[1], 10);
  const maxSolves = parseInt(m[2], 10);
  const totalSolveTimeMs = parseInt(m[3], 10);
  const bottleneckTimeMs = parseInt(m[4], 10);
  if (
    !Number.isFinite(solves) ||
    !Number.isFinite(maxSolves) ||
    !Number.isFinite(totalSolveTimeMs) ||
    !Number.isFinite(bottleneckTimeMs)
  ) {
    return null;
  }
  return { solves, maxSolves, totalSolveTimeMs, bottleneckTimeMs };
}

function buildSolveTryDistribution(entries: InHouseVerificationEntry[]): SolveTryDistribution {
  const dist: SolveTryDistribution = {
    firstTry: 0,
    secondTry: 0,
    thirdTry: 0,
    other: 0,
    total: entries.length,
  };
  for (const e of entries) {
    if (e.solves === 1) dist.firstTry += 1;
    else if (e.solves === 2) dist.secondTry += 1;
    else if (e.solves === 3) dist.thirdTry += 1;
    else dist.other += 1;
  }
  return dist;
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
      solveTryDistribution: buildSolveTryDistribution(inHouseEntries),
      totalSolveTime: computeTimingAnalytics(inHouseEntries.map((e) => e.totalSolveTimeMs)),
      bottleneck: {
        zeroCount,
        nonZeroCount: bottleneckNonZero.length,
        nonZero: computeTimingAnalytics(bottleneckNonZero),
      },
    },
  };
}
