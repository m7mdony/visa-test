"use client";

import { useState, useCallback } from "react";

type LogEntry = { time: string; line: string };

type LivenessJobMetrics = {
  videoPrep?: number;
  videoFileLoaded?: number;
  browserSetup?: number;
  timeToHoldStill?: number;
  totalPublish?: number;
  websocketDisconnect?: number;
};

const SOLVER_OPTIONS = ["liveness-bot", "aws-liveness-automation-staging"] as const;

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

function parseLivenessJobLogs(entries: LogEntry[]): LivenessJobMetrics | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => a.time.localeCompare(b.time));
  const out: LivenessJobMetrics = {};
  const videoPrepMatch = sorted.find((e) => e.line.includes("[TIMING] Video prep:"));
  if (videoPrepMatch) {
    const m = videoPrepMatch.line.match(/\[TIMING\] Video prep: ([\d.]+)s/);
    if (m) out.videoPrep = parseFloat(m[1]);
  }
  const videoFileLoadedMatch = sorted.find(
    (e) => e.line.includes("Video file loaded:") && e.line.includes("from analyze click")
  );
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
    if (Number.isFinite(startMs) && Number.isFinite(holdMs))
      out.timeToHoldStill = (holdMs - startMs) / 1000;
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

type LongExample = { jobId: string; value: number };

type SolverReportSection = {
  avgVideoPrep: number;
  avgVideoFileLoaded: number;
  avgBrowserSetup: number;
  avgTimeToHoldStill: number;
  avgTotalPublish: number;
  avgWebsocketDisconnect: number;
  jobCount: number;
  longWebsocketCount: number;
  longWebsocketExamples: Array<{ jobId: string }>;
  longVideoPrep: { count: number; examples: LongExample[] };
  longVideoFileLoaded: { count: number; examples: LongExample[] };
  longBrowserSetup: { count: number; examples: LongExample[] };
  longTimeToHoldStill: { count: number; examples: LongExample[] };
};

function take3WithValue<T extends { jobId: string }>(arr: (T & { value: number })[]): LongExample[] {
  return arr.slice(0, 3).map(({ jobId, value }) => ({ jobId, value }));
}

function computeSolverSection(jobLogs: Map<string, LogEntry[]>): SolverReportSection | null {
  const metrics: LivenessJobMetrics[] = [];
  const longWebsocket: Array<{ jobId: string; ws: number }> = [];
  const longVideoPrep: Array<{ jobId: string; value: number }> = [];
  const longVideoFileLoaded: Array<{ jobId: string; value: number }> = [];
  const longBrowserSetup: Array<{ jobId: string; value: number }> = [];
  const longTimeToHoldStill: Array<{ jobId: string; value: number }> = [];

  for (const [jobId, entries] of jobLogs.entries()) {
    const m = parseLivenessJobLogs(entries);
    if (!m) continue;
    metrics.push(m);
    if (m.websocketDisconnect != null && m.websocketDisconnect > 11) {
      longWebsocket.push({ jobId, ws: m.websocketDisconnect });
    }
    if (m.videoPrep != null && m.videoPrep > 0.2) {
      longVideoPrep.push({ jobId, value: m.videoPrep });
    }
    if (m.videoFileLoaded != null && m.videoFileLoaded > 0.2) {
      longVideoFileLoaded.push({ jobId, value: m.videoFileLoaded });
    }
    if (m.browserSetup != null && m.browserSetup > 0.5) {
      longBrowserSetup.push({ jobId, value: m.browserSetup });
    }
    if (m.timeToHoldStill != null && m.timeToHoldStill > 4) {
      longTimeToHoldStill.push({ jobId, value: m.timeToHoldStill });
    }
  }

  if (metrics.length === 0) return null;
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
    jobCount: metrics.length,
    longWebsocketExamples: longWebsocket.slice(0, 3).map(({ jobId }) => ({ jobId })),
    longWebsocketCount: longWebsocket.length,
    longVideoPrep: { count: longVideoPrep.length, examples: take3WithValue(longVideoPrep) },
    longVideoFileLoaded: {
      count: longVideoFileLoaded.length,
      examples: take3WithValue(longVideoFileLoaded),
    },
    longBrowserSetup: {
      count: longBrowserSetup.length,
      examples: take3WithValue(longBrowserSetup),
    },
    longTimeToHoldStill: {
      count: longTimeToHoldStill.length,
      examples: take3WithValue(longTimeToHoldStill),
    },
  };
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

export default function LogsClient() {
  const now = Date.now();
  const defaultFrom = new Date(now - INTERVAL_MS["24h"]);
  const defaultTo = new Date(now);
  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(defaultFrom));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(defaultTo));
  const [solverTarget, setSolverTarget] = useState<(typeof SOLVER_OPTIONS)[number]>("liveness-bot");
  const [additionalFilter, setAdditionalFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<SolverReportSection | null>(null);
  const [loadingProgress, setLoadingProgress] = useState<string | null>(null);

  const applyPreset = useCallback((interval: string) => {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["24h"];
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    setFromStr(toDatetimeLocal(from));
    setToStr(toDatetimeLocal(to));
  }, []);

  async function handleGenerate() {
    setError(null);
    setSection(null);
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
      // 1) Fetch solver logs matching "Solving face" to get JOB_IDs
      setLoadingProgress('Fetching "Solving face" logs…');
      const solvingRes = await fetch("/api/grafana-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromMs,
          to: toMs,
          target: solverTarget,
          query: "Solving face",
          ...(additionalFilter.trim() && { additionalFilter: additionalFilter.trim() }),
        }),
      });
      const solvingData = await solvingRes.json().catch(() => ({}));
      if (!solvingRes.ok) {
        setError(solvingData.error || `HTTP ${solvingRes.status}`);
        setLoadingProgress(null);
        setLoading(false);
        return;
      }
      const solvingLogs = (solvingData.logs ?? []) as LogEntry[];
      const jobPrefixes = new Set<string>();
      for (const entry of solvingLogs) {
        const m = entry.line.match(/\[JOB_ID:([a-f0-9-]{8})/i);
        if (m) jobPrefixes.add(m[1]);
      }
      if (jobPrefixes.size === 0) {
        setSection(null);
        setLoadingProgress(null);
        setLoading(false);
        return;
      }

      // 2) For each JOB_ID prefix, fetch detailed logs and build metrics
      const prefixes = [...jobPrefixes];
      const jobLogs = new Map<string, LogEntry[]>();
      const BATCH = 1;
      for (let start = 0; start < prefixes.length; start += BATCH) {
        const end = Math.min(start + BATCH, prefixes.length);
        const batch = prefixes.slice(start, end);
        setLoadingProgress(
          `Fetching ${solverTarget} JOB_ID logs ${start + 1}-${end} of ${prefixes.length}…`
        );
        const prefix = batch[0];
        const entries = await fetch("/api/grafana-logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: fromMs,
            to: toMs,
            target: solverTarget,
            query: `JOB_ID:${prefix}`,
          }),
        })
          .then(async (r) => {
            const d = await r.json().catch(() => ({}));
            return r.ok && Array.isArray(d.logs) ? (d.logs as LogEntry[]) : [];
          })
          .catch(() => []);
        if (entries.length > 0) jobLogs.set(prefix, entries);
      }

      const sec = computeSolverSection(jobLogs);
      setSection(sec);
      setLoadingProgress(null);
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
        <h1 className="text-2xl font-semibold text-zinc-900">Solver report</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Per-day liveness solver metrics, based on JOB_ID logs in the selected solver.
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
          <label className="block text-sm font-medium text-zinc-700 mb-1">Solver</label>
          <select
            value={solverTarget}
            onChange={(e) =>
              setSolverTarget(
                e.target.value === "aws-liveness-automation-staging"
                  ? "aws-liveness-automation-staging"
                  : "liveness-bot"
              )
            }
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          >
            {SOLVER_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">Additional filter (optional)</label>
          <input
            type="text"
            value={additionalFilter}
            onChange={(e) => setAdditionalFilter(e.target.value)}
            placeholder="e.g. fromCountry=ago toCountry=prt"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
          <p className="mt-1 text-xs text-zinc-500">
            Applied when searching for &quot;Solving face&quot; logs in the selected solver.
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={loading}
        className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {loading ? loadingProgress ?? "Generating…" : "Generate solver report"}
      </button>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {section && (
        <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
          <h2 className="text-sm font-semibold text-zinc-900 px-4 py-2 border-b border-zinc-200 bg-zinc-50">
            Solver metrics{" "}
            <span className="font-normal text-zinc-500">
              · {section.jobCount} jobs · {solverTarget}
            </span>
          </h2>
          <div className="px-4 py-3 space-y-4 text-sm">
            <ul className="space-y-1.5">
              <li className="flex justify-between gap-4">
                <span className="text-zinc-700">Avg video prep time</span>
                <span className="font-medium tabular-nums">{fmt(section.avgVideoPrep)}s</span>
              </li>
              <li className="flex justify-between gap-4">
                <span className="text-zinc-700">Avg video file loaded (from analyze click)</span>
                <span className="font-medium tabular-nums">
                  {fmt(section.avgVideoFileLoaded)}s
                </span>
              </li>
              <li className="flex justify-between gap-4">
                <span className="text-zinc-700">Avg browser setup time</span>
                <span className="font-medium tabular-nums">{fmt(section.avgBrowserSetup)}s</span>
              </li>
              <li className="flex justify-between gap-4">
                <span className="text-zinc-700">
                  Avg time to &quot;Hold still&quot; (job start → screen)
                </span>
                <span className="font-medium tabular-nums">
                  {fmt(section.avgTimeToHoldStill)}s
                </span>
              </li>
              <li className="flex justify-between gap-4">
                <span className="text-zinc-700">Avg total (job start to publish)</span>
                <span className="font-medium tabular-nums">{fmt(section.avgTotalPublish)}s</span>
              </li>
              <li className="flex justify-between gap-4">
                <span className="text-zinc-700">Avg websocket connection → disconnection</span>
                <span className="font-medium tabular-nums">
                  {fmt(section.avgWebsocketDisconnect)}s
                </span>
              </li>
            </ul>

            {section.longWebsocketCount > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 mt-2">
                <div className="text-sm font-medium text-amber-900">
                  Jobs with websocket &gt; 11s: {section.longWebsocketCount}
                </div>
                <div className="mt-2 text-xs space-y-2">
                  {section.longWebsocketExamples.map((ex, i) => (
                    <div key={i}>
                      <span className="text-zinc-600">Job ID: </span>
                      <code className="text-zinc-800">{ex.jobId}</code>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {section.longVideoPrep.count > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 mt-2">
                <div className="text-sm font-medium text-amber-900">
                  Jobs with video prep &gt; 0.2s: {section.longVideoPrep.count}
                </div>
                <div className="mt-2 text-xs space-y-2">
                  {section.longVideoPrep.examples.map((ex, i) => (
                    <div key={i}>
                      <span className="text-zinc-600">Job ID: </span>
                      <code className="text-zinc-800">{ex.jobId}</code>
                      <span className="text-zinc-600"> ({ex.value.toFixed(2)}s)</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {section.longVideoFileLoaded.count > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 mt-2">
                <div className="text-sm font-medium text-amber-900">
                  Jobs with video file loaded &gt; 0.2s: {section.longVideoFileLoaded.count}
                </div>
                <div className="mt-2 text-xs space-y-2">
                  {section.longVideoFileLoaded.examples.map((ex, i) => (
                    <div key={i}>
                      <span className="text-zinc-600">Job ID: </span>
                      <code className="text-zinc-800">{ex.jobId}</code>
                      <span className="text-zinc-600"> ({ex.value.toFixed(2)}s)</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {section.longBrowserSetup.count > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 mt-2">
                <div className="text-sm font-medium text-amber-900">
                  Jobs with browser setup &gt; 0.5s: {section.longBrowserSetup.count}
                </div>
                <div className="mt-2 text-xs space-y-2">
                  {section.longBrowserSetup.examples.map((ex, i) => (
                    <div key={i}>
                      <span className="text-zinc-600">Job ID: </span>
                      <code className="text-zinc-800">{ex.jobId}</code>
                      <span className="text-zinc-600"> ({ex.value.toFixed(2)}s)</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {section.longTimeToHoldStill.count > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 mt-2">
                <div className="text-sm font-medium text-amber-900">
                  Jobs with time to &quot;Hold still&quot; &gt; 4s:{" "}
                  {section.longTimeToHoldStill.count}
                </div>
                <div className="mt-2 text-xs space-y-2">
                  {section.longTimeToHoldStill.examples.map((ex, i) => (
                    <div key={i}>
                      <span className="text-zinc-600">Job ID: </span>
                      <code className="text-zinc-800">{ex.jobId}</code>
                      <span className="text-zinc-600"> ({ex.value.toFixed(2)}s)</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {!loading && !section && !error && (
        <p className="text-sm text-zinc-500">
          Set date and solver, then click &quot;Generate solver report&quot; to see metrics.
        </p>
      )}
    </div>
  );
}
