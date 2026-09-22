"use client";

import { useMemo, useState } from "react";
import type { StuckFeedbackEpisode } from "@/lib/stuckFeedback";
import {
  findGestureClipUrl,
  type GestureClipEntry,
} from "@/lib/visaflowDashboardPassports";
import VisaflowDashboardLoginPanel from "@/components/VisaflowDashboardLoginPanel";
import {
  applyRefreshedBearerJwt,
  buildDashboardAuthBody,
  ensureFreshBearerJwt,
  useVisaflowDashboardAuth,
} from "@/lib/visaflowDashboardAuth";

const INTERVAL_MS: Record<string, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

const DASHBOARD_BATCH_SIZE = 5;

type DeploymentEnvUi = "prod" | "staging";

type ApiResponse = {
  from: number;
  to: number;
  deploymentEnv: DeploymentEnvUi;
  solverApp: string;
  totals: {
    stuckQueryLines: number;
    episodeCount: number;
    distinctClips: number;
    withPassport: number;
  };
  clipCounts: Record<string, number>;
  episodes: StuckFeedbackEpisode[];
  error?: string;
};

type DashboardMediaEntry = {
  passportImages?: Array<{ url: string }>;
  gestureClips?: GestureClipEntry[];
  error?: string;
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
  return d.toLocaleString();
}

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900";

const CLIP_ORDER = [
  "up",
  "down",
  "left",
  "right",
  "upLeft",
  "upRight",
  "downLeft",
  "downRight",
  "smile",
];

export default function StuckFeedbackClient() {
  const now = Date.now();
  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(new Date(now - INTERVAL_MS["24h"])));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(new Date(now)));
  const [deploymentEnv, setDeploymentEnv] = useState<DeploymentEnvUi>("prod");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [dashByPassport, setDashByPassport] = useState<Record<string, DashboardMediaEntry>>({});
  const [dashError, setDashError] = useState<string | null>(null);
  const [dashLoading, setDashLoading] = useState(false);
  const [dashProgress, setDashProgress] = useState<string | null>(null);
  const { authenticated: dashboardJwtSaved } = useVisaflowDashboardAuth();

  async function fetchDashboardBatch(
    passportNumbers: string[],
  ): Promise<{ ok: boolean; byPassport: Record<string, DashboardMediaEntry>; topError?: string }> {
    await ensureFreshBearerJwt();
    const { bearerJwt: bearerFromStorage, clerkSessionId: refreshSid, clerkCookie: refreshJar } =
      buildDashboardAuthBody();
    if (
      (!bearerFromStorage || bearerFromStorage.split(".").length < 2) &&
      !(refreshSid?.startsWith("sess_") && refreshJar)
    ) {
      return { ok: false, byPassport: {}, topError: "Sign in with Visaflow dashboard OTP first." };
    }

    const res = await fetch("/api/dashboard-passport-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        passportNumbers,
        bearerJwt: bearerFromStorage,
        ...(refreshSid?.startsWith("sess_") ? { clerkSessionId: refreshSid } : {}),
        ...(refreshJar ? { clerkCookie: refreshJar } : {}),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
      byPassport?: Record<string, DashboardMediaEntry>;
      refreshedBearerJwt?: string;
    };
    applyRefreshedBearerJwt(json.refreshedBearerJwt);
    return {
      ok: res.ok,
      byPassport: json.byPassport ?? {},
      topError: json.error,
    };
  }

  async function loadDashboardClips() {
    if (!data) return;
    const passports = [
      ...new Set(
        data.episodes.map((e) => e.passportNumber?.trim()).filter((p): p is string => Boolean(p)),
      ),
    ];
    if (passports.length === 0) {
      setDashError("No passport numbers in log results to look up.");
      return;
    }

    setDashLoading(true);
    setDashError(null);
    setDashProgress(null);
    const merged: Record<string, DashboardMediaEntry> = { ...dashByPassport };
    let topError: string | null = null;

    try {
      for (let i = 0; i < passports.length; i += DASHBOARD_BATCH_SIZE) {
        const batch = passports.slice(i, i + DASHBOARD_BATCH_SIZE);
        setDashProgress(`Loading dashboard ${i + 1}–${i + batch.length} of ${passports.length}…`);
        const result = await fetchDashboardBatch(batch);
        Object.assign(merged, result.byPassport);
        if (!result.ok && result.topError) topError = result.topError;
      }
      setDashByPassport(merged);
      if (topError) setDashError(topError);
    } catch (e: unknown) {
      setDashError(e instanceof Error ? e.message : "Dashboard fetch failed");
    } finally {
      setDashLoading(false);
      setDashProgress(null);
    }
  }

  async function runSearch() {
    setError(null);
    setDashError(null);
    setLoading(true);
    setData(null);
    setDashByPassport({});

    const from = new Date(fromStr).getTime();
    const to = new Date(toStr).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      setError("From must be before To.");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/stuck-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, deploymentEnv }),
      });
      const json = (await res.json().catch(() => ({}))) as ApiResponse;
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

  const episodes = data?.episodes ?? [];
  const passportCount = useMemo(
    () =>
      new Set(
        episodes.map((e) => e.passportNumber?.trim()).filter((p): p is string => Boolean(p)),
      ).size,
    [episodes],
  );

  const sortedClipCounts = useMemo(() => {
    if (!data?.clipCounts) return [];
    const entries = Object.entries(data.clipCounts);
    entries.sort((a, b) => {
      const ai = CLIP_ORDER.indexOf(a[0]);
      const bi = CLIP_ORDER.indexOf(b[0]);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    });
    return entries;
  }, [data?.clipCounts]);

  const withGestureClipCount = useMemo(() => {
    if (!data) return 0;
    return data.episodes.filter((ep) => {
      const passport = ep.passportNumber?.trim();
      if (!passport) return false;
      const dash = dashByPassport[passport];
      return Boolean(findGestureClipUrl(dash?.gestureClips, ep.clip));
    }).length;
  }, [data, dashByPassport]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900">Stuck feedback</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Step 1: search solver logs for <code className="text-zinc-800">[STUCK-FEEDBACK]</code>. Step 2:
          load passport images + gesture clips from dashboard{" "}
          <code className="text-zinc-800">/applicants/images</code>.
        </p>
      </div>

      <VisaflowDashboardLoginPanel />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-600">From</span>
          <input
            type="datetime-local"
            className={inputClass}
            value={fromStr}
            onChange={(e) => setFromStr(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-600">To</span>
          <input
            type="datetime-local"
            className={inputClass}
            value={toStr}
            onChange={(e) => setToStr(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-600">Environment</span>
          <select
            className={inputClass}
            value={deploymentEnv}
            onChange={(e) => setDeploymentEnv(e.target.value === "staging" ? "staging" : "prod")}
          >
            <option value="prod">Production</option>
            <option value="staging">Staging</option>
          </select>
        </label>
        <div className="flex flex-col justify-end gap-2">
          <div className="flex flex-wrap gap-1">
            {(["15m", "1h", "6h", "24h"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  const ms = INTERVAL_MS[p] ?? INTERVAL_MS["24h"];
                  const to = new Date();
                  setFromStr(toDatetimeLocal(new Date(to.getTime() - ms)));
                  setToStr(toDatetimeLocal(to));
                }}
                className="rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
              >
                {p}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={runSearch}
            disabled={loading}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {loading ? "Searching logs…" : "Search logs"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard label="Stuck log lines" value={data.totals.stuckQueryLines} />
            <StatCard label="Episodes" value={data.totals.episodeCount} />
            <StatCard label="Distinct clips" value={data.totals.distinctClips} />
            <StatCard label="With passport" value={data.totals.withPassport} />
            <StatCard
              label="With gesture clip"
              value={Object.keys(dashByPassport).length > 0 ? withGestureClipCount : "—"}
            />
          </div>

          {data.totals.stuckQueryLines > 0 && data.totals.episodeCount === 0 && (
            <p className="text-sm text-amber-800">
              Found {data.totals.stuckQueryLines} STUCK log lines but no parsed episodes — check log format.
            </p>
          )}

          {sortedClipCounts.length > 0 && (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              <h2 className="text-sm font-semibold text-zinc-900">Stuck count by clip</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {sortedClipCounts.map(([clip, count]) => (
                  <span
                    key={clip}
                    className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1 text-sm"
                  >
                    <span className="font-mono font-medium text-zinc-900">{clip}</span>
                    <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-xs font-semibold text-white">
                      {count}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {episodes.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3">
              <div className="text-sm text-zinc-700">
                <span className="font-medium">Step 2:</span> load dashboard data for {passportCount} passport
                {passportCount === 1 ? "" : "s"}
              </div>
              <button
                type="button"
                onClick={loadDashboardClips}
                disabled={dashLoading || !dashboardJwtSaved}
                className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-50"
              >
                {dashLoading ? (dashProgress ?? "Loading dashboard…") : "Load passport & gesture clips"}
              </button>
              {!dashboardJwtSaved && (
                <span className="text-xs text-zinc-500">Sign in above first.</span>
              )}
            </div>
          )}
        </>
      )}

      {dashError && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {dashError}
        </div>
      )}

      {episodes.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-zinc-200">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Clip</th>
                <th className="px-3 py-2">Max elapsed</th>
                <th className="px-3 py-2">Passport</th>
                <th className="px-3 py-2">Passport image</th>
                <th className="min-w-[240px] px-3 py-2">Gesture clip</th>
                <th className="px-3 py-2">Job</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {episodes.map((ep) => (
                <EpisodeRow
                  key={`${ep.jobId}|${ep.clip}|${ep.startedAt}`}
                  ep={ep}
                  dashByPassport={dashByPassport}
                  dashLoaded={Object.keys(dashByPassport).length > 0}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && episodes.length === 0 && !loading && (
        <p className="text-sm text-zinc-500">No [STUCK-FEEDBACK] episodes in this window.</p>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-zinc-900">{value}</div>
    </div>
  );
}

function EpisodeRow({
  ep,
  dashByPassport,
  dashLoaded,
}: {
  ep: StuckFeedbackEpisode;
  dashByPassport: Record<string, DashboardMediaEntry>;
  dashLoaded: boolean;
}) {
  const passport = ep.passportNumber?.trim() ?? "";
  const dash = passport ? dashByPassport[passport] : undefined;
  const passportImg = dash?.passportImages?.find((p) => p.url?.trim())?.url?.trim();
  const gestureClipUrl = findGestureClipUrl(dash?.gestureClips, ep.clip);
  const jobShort = ep.jobId.includes("|") ? ep.jobId.split("|")[0] : ep.sessionPrefix;

  return (
    <tr className="align-top hover:bg-zinc-50/80">
      <td className="whitespace-nowrap px-3 py-2 text-zinc-700">{fmtTime(ep.startedAt)}</td>
      <td className="px-3 py-2">
        <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 font-mono text-xs font-medium text-amber-900">
          {ep.clip}
        </span>
        {ep.instruction && (
          <div className="mt-1 max-w-[160px] truncate text-xs text-zinc-500" title={ep.instruction}>
            {ep.instruction}
          </div>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-700">
        {ep.maxElapsedMs}ms
        {!ep.endedAt && <span className="ml-1 text-amber-700">open</span>}
      </td>
      <td className="px-3 py-2 font-mono text-xs text-zinc-900">{passport || "—"}</td>
      <td className="px-3 py-2">
        {passportImg ? (
          <a href={passportImg} target="_blank" rel="noopener noreferrer">
            <img
              src={passportImg}
              alt={`Passport ${passport}`}
              className="h-16 w-auto max-w-[120px] rounded border border-zinc-200 object-cover"
            />
          </a>
        ) : passport ? (
          <span className="text-xs text-zinc-400">
            {dashLoaded ? dash?.error ?? "No image" : "Load dashboard"}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2">
        {gestureClipUrl ? (
          <a
            href={gestureClipUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-xs text-blue-600 hover:underline"
          >
            {gestureClipUrl}
          </a>
        ) : passport ? (
          <span className="text-xs text-amber-700">
            {dashLoaded ? `No ${ep.clip} clip on dashboard` : "Load dashboard"}
          </span>
        ) : (
          <span className="text-xs text-zinc-400">Need passport</span>
        )}
      </td>
      <td className="px-3 py-2 font-mono text-xs text-zinc-600" title={ep.jobId}>
        {jobShort}
      </td>
    </tr>
  );
}
