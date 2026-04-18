"use client";

import { useState } from "react";

type SolveKindUi = "drop" | "verification";

type ApiResponse = {
  from: number;
  to: number;
  target: string;
  solveKind?: SolveKindUi;
  vfsCorrelationApp?: string;
  azureCorrelationApp?: string;
  totals: {
    applicantCount: number;
    successCount: number;
    failureCount: number;
    terminalFailureLogCount?: number;
    pendingCount: number;
    solvedOnFirstTry: number;
    solvedOnSecondTry: number;
    solvedOnThirdTry: number;
    solvingLogLines: number;
    solvingLogLinesRaw?: number;
    successLogLines: number;
    failLogLines: number;
    identityVerificationLogLines?: number;
    identityOutcomeLogLines?: number;
    solverLogLines?: number;
    azureLivenessLogLines?: number;
    azureSessionPrefixesMapped?: number;
    solvingExcludedNoTaskId?: number;
    solvingExcludedNoAzureMatch?: number;
    solvingExcludedWrongKind?: number;
    azurePayloadLogLines?: number;
    azureResultFailedLogLines?: number;
    taskPayloadRows?: number;
    azureInvalidTokenJobCount?: number;
  };
  taskPayloadIatRows?: Array<{
    solvingTaskId: string;
    sessionPrefix: string;
    messageId: string | null;
    actualLogTime: string;
    iatTime: string | null;
    invalidToken: boolean;
  }>;
  applicantOutcomes?: Array<{
    email: string;
    outcome: "success" | "failed" | "pending";
    successOnTry: 1 | 2 | 3 | null;
    solverFailureCount?: number;
  }>;
  failureReasonBreakdown?: Array<{
    reason: string;
    count: number;
    samples?: Array<{
      email: string;
      passportNumber: string | null;
      videoLink: string | null;
    }>;
  }>;
};

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

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

function fmtTimeMs(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const base = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
  return `${base}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export default function ApprovedVideosClient() {
  const now = Date.now();
  const defaultFrom = new Date(now - INTERVAL_MS["24h"]);
  const defaultTo = new Date(now);
  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(defaultFrom));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(defaultTo));
  const [target, setTarget] = useState("vfs-global-bot");
  const [solveKind, setSolveKind] = useState<SolveKindUi>("drop");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const unresolvedEmails =
    data?.applicantOutcomes
      ?.filter((o) => o.outcome === "pending")
      .map((o) => o.email)
      .sort((a, b) => a.localeCompare(b)) ?? [];

  function applyPreset(interval: string) {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["24h"];
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    setFromStr(toDatetimeLocal(from));
    setToStr(toDatetimeLocal(to));
  }

  async function handleGenerate() {
    setError(null);
    setLoading(true);
    setData(null);

    const fromMs = new Date(fromStr).getTime();
    const toMs = new Date(toStr).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      setError("From must be before To (use valid date-time).");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/approved-videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromMs,
          to: toMs,
          target: target.trim() || "vfs-global-bot",
          solveKind,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as Partial<ApiResponse> & { error?: string };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        setLoading(false);
        return;
      }
      setData(json as ApiResponse);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">In-house verification outcomes</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Applicants come from <code className="text-xs">Solving in-house identity verification</code> in{" "}
          <code className="text-xs">vfs-global-bot</code>, filtered by job type using the TaskId prefix and{" "}
          <code className="text-xs">azure-liveness-bot</code> lines{" "}
          <code className="text-xs">Solving face verification for session … (passport: …)</code> (
          <code className="text-xs">passport: VERIFICATION</code> = verification; anything else = drop). Final outcomes
          use <code className="text-xs">In-house identity verification completed</code> /{" "}
          <code className="text-xs">failed</code> (plus legacy lines). Solver stats use{" "}
          <code className="text-xs">In-house solver attempt failed</code> per email.
        </p>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
        <span className="block text-sm font-medium text-zinc-700 mb-2">Report job type</span>
        <div className="flex gap-2 flex-wrap" role="group" aria-label="Solve kind">
          {(
            [
              { id: "drop" as const, label: "Drop solves" },
              { id: "verification" as const, label: "Verification solves" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setSolveKind(opt.id)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                solveKind === opt.id
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-300 text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
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
          <label className="block text-sm font-medium text-zinc-700 mb-1">Target app label</label>
          <input
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="vfs-global-bot"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={loading}
        className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {loading ? "Loading..." : "Run report"}
      </button>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {data && (
        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
            <div>
              Window: <span className="font-medium">{fmtTime(new Date(data.from).toISOString())}</span> →{" "}
              <span className="font-medium">{fmtTime(new Date(data.to).toISOString())}</span>
              {data.vfsCorrelationApp ? (
                <>
                  {" "}
                  · correlation <code>{data.vfsCorrelationApp}</code>
                </>
              ) : null}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Report:{" "}
              <span className="font-medium text-zinc-700">
                {data.solveKind === "verification" ? "Verification solves" : "Drop solves"}
              </span>
              {data.azureCorrelationApp ? (
                <>
                  {" "}
                  · Azure <code>{data.azureCorrelationApp}</code>
                </>
              ) : null}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Applicants: <span className="font-medium text-zinc-700">{data.totals.applicantCount}</span> · VFS solving
              lines (included / raw): {data.totals.solvingLogLines} /{" "}
              {data.totals.solvingLogLinesRaw ?? "—"} · identity query / outcome lines:{" "}
              {data.totals.identityVerificationLogLines ?? "—"} / {data.totals.identityOutcomeLogLines ?? "—"} ·
              success / fail lines: {data.totals.successLogLines} / {data.totals.failLogLines} · solver lines:{" "}
              {data.totals.solverLogLines ?? "—"}
              {data.totals.azureLivenessLogLines != null ? (
                <>
                  {" "}
                  · Azure liveness lines: {data.totals.azureLivenessLogLines} (session prefixes mapped:{" "}
                  {data.totals.azureSessionPrefixesMapped ?? "—"})
                </>
              ) : null}
            </div>
            {(data.totals.solvingExcludedNoTaskId ?? 0) +
              (data.totals.solvingExcludedNoAzureMatch ?? 0) +
              (data.totals.solvingExcludedWrongKind ?? 0) >
              0 && (
              <div className="mt-1 text-[11px] text-zinc-500">
                Excluded VFS solving lines: no TaskId {data.totals.solvingExcludedNoTaskId ?? 0}, no Azure match{" "}
                {data.totals.solvingExcludedNoAzureMatch ?? 0}, other job type {data.totals.solvingExcludedWrongKind ?? 0}
              </div>
            )}
            <div className="mt-1 text-[11px] text-zinc-500">
              Azure payload logs: {data.totals.azurePayloadLogLines ?? 0} · correlated rows{" "}
              {data.totals.taskPayloadRows ?? 0} (via VFS solving TaskId prefix) ·{" "}
              <code>[RESULT] FAILED</code> lines: {data.totals.azureResultFailedLogLines ?? 0} · InvalidToken jobs
              (prefix match): {data.totals.azureInvalidTokenJobCount ?? 0}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-5">
              <div className="text-sm font-medium text-emerald-900">Success</div>
              <div className="mt-1 text-3xl font-semibold text-emerald-950">{data.totals.successCount}</div>
            </div>
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-5">
              <div className="text-sm font-medium text-rose-900">Failed — terminal</div>
              <div className="mt-1 text-3xl font-semibold text-rose-950">{data.totals.failureCount}</div>
              <div className="mt-1 text-xs text-rose-800">Applicants who did not succeed</div>
              <div className="mt-4 pt-3 border-t border-rose-200/80">
                <div className="text-xs font-medium text-rose-900">In-house solver attempt failures</div>
                <div className="mt-1 text-2xl font-semibold text-rose-950">
                  {data.totals.terminalFailureLogCount ?? "—"}
                </div>
                <div className="mt-1 text-[11px] text-rose-800">
                  Total <code className="text-[10px]">In-house solver attempt failed</code> lines for applicants in the
                  failed cohort (same window).
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-5">
              <div className="text-sm font-medium text-amber-900">Unresolved</div>
              <div className="mt-1 text-3xl font-semibold text-amber-950">{data.totals.pendingCount}</div>
              <div className="mt-1 text-xs text-amber-800">Started solve, no terminal success/failure in window</div>
              {unresolvedEmails.length > 0 && (
                <div className="mt-4 pt-3 border-t border-amber-200/80">
                  <div className="text-xs font-medium text-amber-900">Session emails</div>
                  <div className="mt-2 max-h-36 overflow-auto rounded border border-amber-200 bg-amber-100/40 px-2 py-1.5">
                    {unresolvedEmails.map((email) => (
                      <div key={email} className="font-mono text-[11px] text-amber-900 break-all">
                        {email}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {(data.failureReasonBreakdown ?? []).length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-zinc-800 mb-2">
                Solver errors (failed applicants, <code className="text-[10px]">Error=</code> from in-house solver)
              </h2>
              <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
                <table className="min-w-full text-xs">
                  <thead className="bg-zinc-100 text-zinc-800">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">Count</th>
                      <th className="px-3 py-2 text-left font-semibold">Error / message</th>
                      <th className="px-3 py-2 text-left font-semibold">3 random examples</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.failureReasonBreakdown ?? []).map((row) => (
                      <tr key={row.reason} className="border-t border-zinc-100 align-top">
                        <td className="px-3 py-2 font-mono font-semibold text-zinc-900 whitespace-nowrap w-16">
                          {row.count}
                        </td>
                        <td className="px-3 py-2 font-mono text-zinc-800 break-all">{row.reason}</td>
                        <td className="px-3 py-2 text-zinc-800">
                          {(row.samples ?? []).length === 0 ? (
                            <span className="text-zinc-500">—</span>
                          ) : (
                            <div className="space-y-2">
                              {(row.samples ?? []).map((s, idx) => (
                                <div key={`${s.email}-${s.passportNumber ?? "na"}-${idx}`} className="text-[11px]">
                                  <div>
                                    <span className="font-semibold">Email:</span> <span className="font-mono">{s.email}</span>
                                  </div>
                                  <div>
                                    <span className="font-semibold">Passport:</span>{" "}
                                    <span className="font-mono">{s.passportNumber ?? "—"}</span>
                                  </div>
                                  <div>
                                    <span className="font-semibold">Video:</span>{" "}
                                    {s.videoLink ? (
                                      <a
                                        href={s.videoLink}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-blue-700 underline break-all"
                                      >
                                        {s.videoLink}
                                      </a>
                                    ) : (
                                      <span className="font-mono">—</span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
}

