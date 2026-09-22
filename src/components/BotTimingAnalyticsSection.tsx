import type { BotTimingReport } from "@/lib/botTimingStats";
import type { TimingAnalytics } from "@/lib/timingAnalytics";

function fmtMs(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toLocaleString()} ms`;
}

function AttemptPassedTimingBreakdownBar({
  totalAvgMs,
  wasmAvgMs,
  singleModelAvgMs,
  wasmCount,
}: {
  totalAvgMs: number;
  wasmAvgMs: number;
  singleModelAvgMs: number;
  wasmCount: number;
}) {
  const wasmPct = Math.min(100, Math.max(0, (wasmAvgMs / totalAvgMs) * 100));
  const singleModelPct = Math.max(0, 100 - wasmPct);

  return (
    <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50/40 px-3 py-3">
      <div className="text-xs font-medium text-violet-950 mb-1">Avg time breakdown</div>
      <p className="text-[11px] text-violet-800/90 mb-3">
        WASM solve avg from <code className="text-[10px]">[WASM] Pool job done in …s</code> (n={wasmCount}) vs total{" "}
        <code className="text-[10px]">Attempt … passed</code> avg ({fmtMs(totalAvgMs)}).
      </p>
      <div className="flex h-7 w-full overflow-hidden rounded-md border border-violet-200 bg-white shadow-inner">
        <div
          className="flex items-center justify-center bg-emerald-500/90 text-[10px] font-medium text-white transition-all"
          style={{ width: `${wasmPct}%` }}
          title={`WASM solve: ${fmtMs(wasmAvgMs)}`}
        >
          {wasmPct >= 14 ? `${Math.round(wasmPct)}%` : ""}
        </div>
        <div
          className="flex items-center justify-center bg-amber-500/90 text-[10px] font-medium text-white transition-all"
          style={{ width: `${singleModelPct}%` }}
          title={`singleModel / request: ${fmtMs(singleModelAvgMs)}`}
        >
          {singleModelPct >= 14 ? `${Math.round(singleModelPct)}%` : ""}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500/90 shrink-0" />
          <span className="text-zinc-700">
            WASM solve <span className="font-mono font-medium text-zinc-900">{fmtMs(wasmAvgMs)}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-500/90 shrink-0" />
          <span className="text-zinc-700">
            singleModel / request{" "}
            <span className="font-mono font-medium text-zinc-900">{fmtMs(singleModelAvgMs)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function TimingStatsTable({ stats, label }: { stats: TimingAnalytics | null; label: string }) {
  if (!stats) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
        {label}: no data
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
      <div className="px-3 py-2 bg-zinc-50 border-b border-zinc-200 text-xs font-medium text-zinc-800">
        {label} <span className="text-zinc-500 font-normal">(n={stats.count})</span>
      </div>
      <table className="w-full text-xs">
        <tbody>
          <tr className="border-b border-zinc-100">
            <td className="px-3 py-1.5 text-zinc-600 w-36">Min</td>
            <td className="px-3 py-1.5 font-mono font-medium">{fmtMs(stats.min)}</td>
            <td className="px-3 py-1.5 text-zinc-600 w-36">Max</td>
            <td className="px-3 py-1.5 font-mono font-medium">{fmtMs(stats.max)}</td>
          </tr>
          <tr className="border-b border-zinc-100">
            <td className="px-3 py-1.5 text-zinc-600">Avg</td>
            <td className="px-3 py-1.5 font-mono font-medium" colSpan={3}>
              {fmtMs(stats.avg)}
            </td>
          </tr>
          <tr className="border-b border-zinc-100">
            <td className="px-3 py-1.5 text-zinc-600">Outliers</td>
            <td className="px-3 py-1.5 font-mono font-medium" colSpan={3}>
              {stats.outlierCount === 0 ? (
                <span className="text-emerald-700">none</span>
              ) : (
                <span>
                  {stats.outlierCount} —{" "}
                  <span className="text-rose-800">{stats.outliers.map((v) => `${v}ms`).join(", ")}</span>
                </span>
              )}
            </td>
          </tr>
          <tr>
            <td className="px-3 py-1.5 text-zinc-600">Avg w/o outliers</td>
            <td className="px-3 py-1.5 font-mono font-medium" colSpan={3}>
              {fmtMs(stats.trimmedAvg)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default function BotTimingAnalyticsSection({ report }: { report: BotTimingReport }) {
  const bn = report.inHouseVerification.bottleneck;
  const breakdown = report.attemptPassed.breakdown;
  const totalAvgMs = report.attemptPassed.overall?.avg ?? null;
  const wasmAvgMs = breakdown?.wasmSolve?.avg ?? null;
  const singleModelAvgMs = breakdown?.singleModelOverheadAvgMs ?? null;
  const showBreakdownBar =
    totalAvgMs != null &&
    wasmAvgMs != null &&
    singleModelAvgMs != null &&
    (breakdown?.wasmSolve?.count ?? 0) > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-medium text-zinc-800 mb-1">
          Bot job result timing (<code className="text-[10px]">Attempt … passed (…ms)</code>)
        </h2>
        <p className="text-xs text-zinc-500 mb-3">
          When the bot received solver job results. {report.attemptPassed.overall?.count ?? 0} timings from{" "}
          {report.attemptPassed.logLineCount} log lines.
        </p>
        <TimingStatsTable stats={report.attemptPassed.overall} label="All passed attempts" />
        {showBreakdownBar ? (
          <AttemptPassedTimingBreakdownBar
            totalAvgMs={totalAvgMs}
            wasmAvgMs={wasmAvgMs}
            singleModelAvgMs={singleModelAvgMs}
            wasmCount={breakdown!.wasmSolve!.count}
          />
        ) : breakdown?.wasmLogLineCount === 0 ? (
          <p className="mt-2 text-[11px] text-zinc-500">
            No <code className="text-[10px]">[WASM] Pool job done</code> lines in window for breakdown.
          </p>
        ) : null}
      </div>

      <div>
        <h2 className="text-sm font-medium text-zinc-800 mb-1">
          In-house verification solve timing (
          <code className="text-[10px]">In-house verification passed [TimeTaken=…, BottleneckTime=…]</code>)
        </h2>
        <p className="text-xs text-zinc-500 mb-3">
          Full solve time until bot fetches VFS results. {report.inHouseVerification.parsedCount} of{" "}
          {report.inHouseVerification.logLineCount} lines parsed.
        </p>

        <div className="mb-4">
          <div className="rounded-lg border border-sky-200 bg-sky-50/50 px-4 py-3">
            <div className="text-xs font-medium text-sky-900 mb-2">Bottleneck time</div>
            <div className="grid grid-cols-2 gap-2 text-center mb-3 max-w-xs">
              <div className="rounded bg-white border border-sky-100 px-2 py-2">
                <div className="text-lg font-semibold text-sky-950">{bn.zeroCount}</div>
                <div className="text-[10px] text-sky-800">0 ms</div>
              </div>
              <div className="rounded bg-white border border-sky-100 px-2 py-2">
                <div className="text-lg font-semibold text-sky-950">{bn.nonZeroCount}</div>
                <div className="text-[10px] text-sky-800">non-zero</div>
              </div>
            </div>
            {bn.nonZero ? (
              <TimingStatsTable stats={bn.nonZero} label="Non-zero bottleneck" />
            ) : (
              <p className="text-xs text-sky-700">No non-zero bottleneck times.</p>
            )}
          </div>
        </div>

        <TimingStatsTable stats={report.inHouseVerification.totalSolveTime} label="TotalSolveTime" />
      </div>
    </div>
  );
}
