import type { BotTimingReport } from "@/lib/botTimingStats";
import type { TimingAnalytics } from "@/lib/timingAnalytics";

function fmtMs(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toLocaleString()} ms`;
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
  const dist = report.inHouseVerification.solveTryDistribution;
  const bn = report.inHouseVerification.bottleneck;

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
      </div>

      <div>
        <h2 className="text-sm font-medium text-zinc-800 mb-1">
          In-house verification solve timing (<code className="text-[10px]">In-house verification passed</code>)
        </h2>
        <p className="text-xs text-zinc-500 mb-3">
          Full solve time until bot fetches VFS results. {report.inHouseVerification.parsedCount} of{" "}
          {report.inHouseVerification.logLineCount} lines parsed.
        </p>

        <div className="grid gap-4 lg:grid-cols-2 mb-4">
          <div className="rounded-lg border border-violet-200 bg-violet-50/50 px-4 py-3">
            <div className="text-xs font-medium text-violet-900 mb-2">Succeeded on which try (solves=N/3)</div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded bg-white border border-violet-100 px-2 py-2">
                <div className="text-lg font-semibold text-violet-950">{dist.firstTry}</div>
                <div className="text-[10px] text-violet-800">1st try</div>
              </div>
              <div className="rounded bg-white border border-violet-100 px-2 py-2">
                <div className="text-lg font-semibold text-violet-950">{dist.secondTry}</div>
                <div className="text-[10px] text-violet-800">2nd try</div>
              </div>
              <div className="rounded bg-white border border-violet-100 px-2 py-2">
                <div className="text-lg font-semibold text-violet-950">{dist.thirdTry}</div>
                <div className="text-[10px] text-violet-800">3rd try</div>
              </div>
            </div>
            {dist.other > 0 ? (
              <p className="mt-2 text-[10px] text-violet-700">Other: {dist.other}</p>
            ) : null}
          </div>

          <div className="rounded-lg border border-sky-200 bg-sky-50/50 px-4 py-3">
            <div className="text-xs font-medium text-sky-900 mb-2">Bottleneck time</div>
            <div className="grid grid-cols-2 gap-2 text-center mb-3">
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
