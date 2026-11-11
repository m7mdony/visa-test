"use client";

import { useCallback, useMemo, useState } from "react";
import VisaflowDashboardLoginPanel from "@/components/VisaflowDashboardLoginPanel";
import type { ExposureCohortLogSource, ExposureCohortRow } from "@/lib/exposureCheckCohort";
import { EXPOSURE_COHORT_LOG_SOURCES, pickColorVideoUrl } from "@/lib/exposureCheckCohort";
import {
  applyRefreshedBearerJwt,
  buildDashboardAuthBody,
  ensureFreshBearerJwt,
  useVisaflowDashboardAuth,
} from "@/lib/visaflowDashboardAuth";
import { normalizePassportKey } from "@/lib/visaflowDashboardPassports";

const INTERVAL_MS: Record<string, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

type DeploymentEnvUi = "prod" | "staging";

type DashboardEntry = {
  passportImages: Array<{ url: string }>;
  videos: string[];
  error?: string;
};

type CohortResponse = {
  from: number;
  to: number;
  deploymentEnv: DeploymentEnvUi;
  logSource?: ExposureCohortLogSource;
  lokiQuery?: string;
  totals: {
    lokiLines: number;
    rowCount: number;
    withPassport: number;
  };
  rows: ExposureCohortRow[];
  error?: string;
};

type RunState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "waiting"; startedAt: number; resultPollKeys: string[] }
  | {
      phase: "done";
      success: boolean;
      failureReason: string | null;
      precheckVerdict: string | null;
    }
  | { phase: "error"; message: string };

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900";

function toDatetimeLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString();
}

function dashForPassport(
  passportNumber: string | null,
  byPassport: Record<string, DashboardEntry>
): DashboardEntry | undefined {
  const k = passportNumber?.trim();
  if (!k) return undefined;
  return byPassport[k] ?? byPassport[normalizePassportKey(k)];
}

function verdictLabel(state: RunState): string {
  if (state.phase === "idle") return "—";
  if (state.phase === "submitting") return "Submitting…";
  if (state.phase === "waiting") return "Waiting for staging…";
  if (state.phase === "error") return state.message;
  if (state.precheckVerdict === "clipped") return "Precheck: clipped exposure";
  if (state.precheckVerdict === "low_quality") return "Precheck: low quality";
  if (state.precheckVerdict === "no_face") return "Precheck: no face";
  if (state.precheckVerdict === "other_fail") return `Precheck fail: ${state.failureReason ?? "?"}`;
  if (state.success) return "Precheck passed (job finished OK)";
  return state.failureReason ? `Failed: ${state.failureReason}` : "Failed (unknown)";
}

function verdictClass(state: RunState): string {
  if (state.phase === "waiting" || state.phase === "submitting") return "text-amber-700";
  if (state.phase === "error") return "text-red-700";
  if (state.phase !== "done") return "text-zinc-500";
  if (
    state.precheckVerdict === "clipped" ||
    state.precheckVerdict === "low_quality" ||
    state.precheckVerdict === "no_face" ||
    state.precheckVerdict === "other_fail"
  ) {
    return "text-red-800 font-medium";
  }
  if (state.success) return "text-emerald-800 font-medium";
  return "text-red-800";
}

const POLL_MS = 2500;
const POLL_TIMEOUT_MS = 180_000;

export default function ExposureCheckClient() {
  const now = Date.now();
  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(new Date(now - INTERVAL_MS["24h"])));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(new Date(now)));
  const [deploymentEnv, setDeploymentEnv] = useState<DeploymentEnvUi>("prod");
  const [logSource, setLogSource] = useState<ExposureCohortLogSource>("in_house_ver");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CohortResponse | null>(null);
  const [dashByPassport, setDashByPassport] = useState<Record<string, DashboardEntry>>({});
  const [dashLoading, setDashLoading] = useState(false);
  const [dashError, setDashError] = useState<string | null>(null);
  const [runByRow, setRunByRow] = useState<Record<string, RunState>>({});
  const [parallelCount, setParallelCount] = useState("4");
  const [runAllActive, setRunAllActive] = useState(false);
  const [runAllProgress, setRunAllProgress] = useState<{ done: number; total: number } | null>(null);
  const { authenticated: dashboardJwtSaved } = useVisaflowDashboardAuth();

  const passportNumbers = useMemo(() => {
    const set = new Set<string>();
    for (const row of data?.rows ?? []) {
      const p = row.passportNumber?.trim();
      if (p) set.add(p);
    }
    return [...set].sort();
  }, [data?.rows]);

  const loadDashboard = useCallback(async () => {
    if (passportNumbers.length === 0) {
      setDashError("No passport numbers in cohort — widen the time range.");
      return;
    }
    await ensureFreshBearerJwt();
    const { bearerJwt, clerkSessionId, clerkCookie } = buildDashboardAuthBody();
    if (
      (!bearerJwt || bearerJwt.split(".").length < 2) &&
      !(clerkSessionId?.startsWith("sess_") && clerkCookie)
    ) {
      setDashError("Sign in with Visaflow dashboard OTP first.");
      return;
    }
    setDashLoading(true);
    setDashError(null);
    try {
      const res = await fetch("/api/dashboard-passport-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          passportNumbers,
          bearerJwt,
          ...(clerkSessionId?.startsWith("sess_") ? { clerkSessionId } : {}),
          ...(clerkCookie ? { clerkCookie } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        byPassport?: Record<string, DashboardEntry>;
        refreshedBearerJwt?: string;
      };
      if (!res.ok) {
        setDashError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      applyRefreshedBearerJwt(json.refreshedBearerJwt);
      setDashByPassport(json.byPassport ?? {});
    } catch (e: unknown) {
      setDashError(e instanceof Error ? e.message : "Dashboard fetch failed");
    } finally {
      setDashLoading(false);
    }
  }, [passportNumbers]);

  function applyPreset(interval: string) {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["24h"];
    const to = new Date();
    setFromStr(toDatetimeLocal(new Date(to.getTime() - ms)));
    setToStr(toDatetimeLocal(to));
  }

  async function runSearch() {
    setError(null);
    setData(null);
    setDashByPassport({});
    setDashError(null);
    setRunByRow({});
    setLoading(true);
    const from = new Date(fromStr).getTime();
    const to = new Date(toStr).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      setError("From must be before To.");
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/exposure-check-cohort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, deploymentEnv, logSource }),
      });
      const json = (await res.json().catch(() => ({}))) as CohortResponse;
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  async function pollUntilDone(rowKey: string, resultPollKeys: string[], startedAt: number): Promise<void> {
    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const res = await fetch("/api/exposure-check/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resultPollKeys }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          ready?: boolean;
          success?: boolean;
          failureReason?: string | null;
          precheckVerdict?: string | null;
          error?: string;
        };
        if (!res.ok) {
          setRunByRow((prev) => ({
            ...prev,
            [rowKey]: { phase: "error", message: json.error ?? `HTTP ${res.status}` },
          }));
          return;
        }
        if (json.ready) {
          setRunByRow((prev) => ({
            ...prev,
            [rowKey]: {
              phase: "done",
              success: !!json.success,
              failureReason: json.failureReason ?? null,
              precheckVerdict: json.precheckVerdict ?? null,
            },
          }));
          return;
        }
      } catch (e: unknown) {
        setRunByRow((prev) => ({
          ...prev,
          [rowKey]: { phase: "error", message: e instanceof Error ? e.message : "Poll failed" },
        }));
        return;
      }
    }
    setRunByRow((prev) => ({
      ...prev,
      [rowKey]: { phase: "error", message: "Timed out waiting for staging result" },
    }));
  }

  async function runExposureCheck(row: ExposureCohortRow): Promise<void> {
    const dash = dashForPassport(row.passportNumber, dashByPassport);
    const passportURL = dash?.passportImages?.find((p) => p.url?.trim())?.url?.trim() ?? "";
    const videoUrl = pickColorVideoUrl(dash?.videos);
    const pn = row.passportNumber?.trim();
    if (!pn) {
      setRunByRow((prev) => ({
        ...prev,
        [row.rowKey]: { phase: "error", message: "No passport number in VFS log" },
      }));
      return;
    }
    if (!dash || dash.error) {
      setRunByRow((prev) => ({
        ...prev,
        [row.rowKey]: { phase: "error", message: dash?.error ?? "Load dashboard first" },
      }));
      return;
    }
    if (!passportURL || !videoUrl) {
      setRunByRow((prev) => ({
        ...prev,
        [row.rowKey]: {
          phase: "error",
          message: !passportURL ? "No passport image on dashboard" : "No color video on dashboard",
        },
      }));
      return;
    }

    const existing = runByRow[row.rowKey];
    if (existing?.phase === "submitting" || existing?.phase === "waiting") {
      return;
    }

    setRunByRow((prev) => ({ ...prev, [row.rowKey]: { phase: "submitting" } }));
    try {
      const res = await fetch("/api/exposure-check/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl, passportNumber: pn, passportURL }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        resultPollKeys?: string[];
      };
      if (!res.ok) {
        setRunByRow((prev) => ({
          ...prev,
          [row.rowKey]: { phase: "error", message: json.error ?? `HTTP ${res.status}` },
        }));
        return;
      }
      const keys = json.resultPollKeys ?? [];
      const startedAt = Date.now();
      setRunByRow((prev) => ({
        ...prev,
        [row.rowKey]: { phase: "waiting", startedAt, resultPollKeys: keys },
      }));
      await pollUntilDone(row.rowKey, keys, startedAt);
    } catch (e: unknown) {
      setRunByRow((prev) => ({
        ...prev,
        [row.rowKey]: { phase: "error", message: e instanceof Error ? e.message : "Submit failed" },
      }));
    }
  }

  const rows = data?.rows ?? [];

  const runnableRows = useMemo(() => {
    return rows.filter((row) => {
      const dash = dashForPassport(row.passportNumber, dashByPassport);
      const passportURL = dash?.passportImages?.find((p) => p.url?.trim())?.url?.trim();
      const videoUrl = pickColorVideoUrl(dash?.videos);
      return Boolean(row.passportNumber?.trim() && dash && !dash.error && passportURL && videoUrl);
    });
  }, [rows, dashByPassport]);

  async function runAllOnStaging() {
    const parsed = Number.parseInt(parallelCount.trim(), 10);
    const limit = Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 50) : 1;
    const queue = [...runnableRows];
    if (queue.length === 0) {
      setDashError("Load dashboard media first — no runnable rows.");
      return;
    }

    setRunAllActive(true);
    setRunAllProgress({ done: 0, total: queue.length });
    let done = 0;
    let cursor = 0;

    async function worker() {
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= queue.length) return;
        await runExposureCheck(queue[idx]);
        done += 1;
        setRunAllProgress({ done, total: queue.length });
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, () => worker()));
    } finally {
      setRunAllActive(false);
      setRunAllProgress(null);
    }
  }

  return (
    <div className="w-full space-y-6 max-w-[1400px]">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Exposure precheck (staging)</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Pull VFS <code className="text-xs">In-house ver</code> logs for a time window, resolve passport + color video
          from the dashboard, then enqueue a job on{" "}
          <code className="text-xs">azure:identity-verification:stream:staging</code> to exercise{" "}
          <code className="text-xs">WASM_FACE_PRECHECK</code> (clipping / quality / face). Best with staging{" "}
          <code className="text-xs">enforce</code> so precheck failures publish immediately.
        </p>
      </div>

      <VisaflowDashboardLoginPanel />

      <div className="rounded-lg border border-zinc-200 bg-white p-4 space-y-4">
        <div className="flex flex-wrap gap-2">
          {(["15m", "1h", "6h", "24h"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => applyPreset(p)}
              className="text-xs px-2 py-1 rounded border border-zinc-300 hover:bg-zinc-50"
            >
              Last {p}
            </button>
          ))}
        </div>
        <div className="space-y-2">
          <p className="text-sm text-zinc-600">Loki line filter</p>
          <div className="flex flex-wrap gap-4">
            {(Object.keys(EXPOSURE_COHORT_LOG_SOURCES) as ExposureCohortLogSource[]).map((key) => (
              <label key={key} className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="logSource"
                  className="mt-1"
                  checked={logSource === key}
                  onChange={() => setLogSource(key)}
                />
                <span>
                  <span className="font-medium text-zinc-900">{EXPOSURE_COHORT_LOG_SOURCES[key].label}</span>
                  <span className="block text-xs text-zinc-500">{EXPOSURE_COHORT_LOG_SOURCES[key].description}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block text-sm">
            <span className="text-zinc-600">From</span>
            <input type="datetime-local" className={inputClass + " mt-1"} value={fromStr} onChange={(e) => setFromStr(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-600">To</span>
            <input type="datetime-local" className={inputClass + " mt-1"} value={toStr} onChange={(e) => setToStr(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-600">VFS logs</span>
            <select
              className={inputClass + " mt-1"}
              value={deploymentEnv}
              onChange={(e) => setDeploymentEnv(e.target.value === "staging" ? "staging" : "prod")}
            >
              <option value="prod">Production</option>
              <option value="staging">Staging</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={() => void runSearch()}
            className="px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm font-medium disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load cohort"}
          </button>
          <button
            type="button"
            disabled={dashLoading || rows.length === 0}
            onClick={() => void loadDashboard()}
            className="px-4 py-2 rounded-lg border border-zinc-300 text-sm font-medium disabled:opacity-50 hover:bg-zinc-50"
          >
            {dashLoading ? "Dashboard…" : "Load dashboard media"}
          </button>
          {dashboardJwtSaved ? (
            <span className="text-xs text-emerald-700 self-center">Dashboard JWT saved</span>
          ) : null}
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <span className="whitespace-nowrap">Parallel</span>
            <input
              type="number"
              min={1}
              max={50}
              className="w-16 rounded-lg border border-zinc-300 px-2 py-1.5 text-sm"
              value={parallelCount}
              disabled={runAllActive}
              onChange={(e) => setParallelCount(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={runAllActive || runnableRows.length === 0}
            onClick={() => void runAllOnStaging()}
            className="px-4 py-2 rounded-lg border border-zinc-900 text-zinc-900 text-sm font-medium disabled:opacity-50 hover:bg-zinc-50"
          >
            {runAllActive
              ? `Running all… ${runAllProgress ? `${runAllProgress.done}/${runAllProgress.total}` : ""}`
              : `Run all (${runnableRows.length})`}
          </button>
        </div>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        {dashError ? <p className="text-sm text-amber-800">{dashError}</p> : null}
        {data ? (
          <p className="text-xs text-zinc-500">
            Query <code className="text-zinc-700">{data.lokiQuery ?? logSource}</code> · {data.totals.rowCount} row(s) ·{" "}
            {data.totals.withPassport} with passport · {data.totals.lokiLines} Loki lines
          </p>
        ) : null}
      </div>

      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-zinc-200">
          <table className="min-w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Passport</th>
                <th className="px-3 py-2">VFS event</th>
                <th className="px-3 py-2">Passport image</th>
                <th className="px-3 py-2">Color video</th>
                <th className="px-3 py-2">Staging precheck</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((row) => {
                const dash = dashForPassport(row.passportNumber, dashByPassport);
                const passportURL = dash?.passportImages?.[0]?.url;
                const videoUrl = pickColorVideoUrl(dash?.videos);
                const run = runByRow[row.rowKey] ?? { phase: "idle" as const };
                return (
                  <tr key={row.rowKey} className="align-top">
                    <td className="px-3 py-2 whitespace-nowrap text-xs">{fmtTime(row.eventAt)}</td>
                    <td className="px-3 py-2 font-mono text-xs break-all max-w-[160px]">{row.email}</td>
                    <td className="px-3 py-2 font-mono">{row.passportNumber ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          row.eventKind === "passed"
                            ? "text-emerald-700"
                            : row.eventKind === "failed"
                              ? "text-red-700"
                              : "text-zinc-600"
                        }
                      >
                        {row.eventKind}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {!passportURL ? (
                        <span className="text-zinc-400 text-xs">—</span>
                      ) : (
                        <a href={passportURL} target="_blank" rel="noreferrer" className="inline-block">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={passportURL}
                            alt=""
                            className="h-20 w-auto max-w-[120px] object-cover rounded border border-zinc-200"
                            referrerPolicy="no-referrer"
                          />
                        </a>
                      )}
                    </td>
                    <td className="px-3 py-2 max-w-[200px]">
                      {!videoUrl ? (
                        <span className="text-zinc-400 text-xs">Load dashboard</span>
                      ) : (
                        <div className="space-y-1">
                          <video
                            src={videoUrl}
                            controls
                            className="rounded border border-zinc-200 w-full max-h-24"
                            preload="metadata"
                          />
                          <a href={videoUrl} target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 underline">
                            open
                          </a>
                        </div>
                      )}
                    </td>
                    <td className={`px-3 py-2 text-xs max-w-[180px] ${verdictClass(run)}`}>{verdictLabel(run)}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        disabled={run.phase === "submitting" || run.phase === "waiting"}
                        onClick={() => void runExposureCheck(row)}
                        className="text-xs px-3 py-1.5 rounded-md bg-zinc-900 text-white disabled:opacity-50 whitespace-nowrap"
                      >
                        Run on staging
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
