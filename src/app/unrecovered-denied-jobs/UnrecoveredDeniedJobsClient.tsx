"use client";

import { useMemo, useState } from "react";
import type { DeniedPassportRow } from "@/lib/deniedPassports";
import type { DeniedEmailRecovery } from "@/lib/deniedRecovery";
import { collectPassportsFromReportData } from "@/lib/reportEvents";
import {
  buildNotRecoveredStagingJobs,
  chunkStagingJobs,
  STAGING_JOBS_BATCH_SIZE,
  type DashboardMediaEntry,
  type SkippedApplicant,
  type StagingJob,
  type StagingJobBatch,
} from "@/lib/stagingJobBatches";

import VisaflowDashboardLoginPanel from "@/components/VisaflowDashboardLoginPanel";
import {
  applyRefreshedBearerJwt,
  buildDashboardAuthBody,
  useVisaflowDashboardAuth,
} from "@/lib/visaflowDashboardAuth";

const INTERVAL_MS: Record<string, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

type DeploymentEnvUi = "prod" | "staging";

type ReportPayload = {
  deniedPassportRows?: DeniedPassportRow[];
  deniedRecoveryByEmail?: Record<string, DeniedEmailRecovery>;
  deniedPassportErrors?: string[];
};

function toDatetimeLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

export default function UnrecoveredDeniedJobsClient() {
  const now = Date.now();
  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(new Date(now - INTERVAL_MS["24h"])));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(new Date(now)));
  const [target, setTarget] = useState("vfs-global-bot");
  const [deploymentEnv, setDeploymentEnv] = useState<DeploymentEnvUi>("prod");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [dashByPassport, setDashByPassport] = useState<Record<string, DashboardMediaEntry>>({});
  const [dashError, setDashError] = useState<string | null>(null);
  const { authenticated: dashboardJwtSaved } = useVisaflowDashboardAuth();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  async function fetchDashboardForPassports(passportNumbers: string[]) {
    const { bearerJwt: bearerFromStorage, clerkSessionId: refreshSid, clerkCookie: refreshJar } =
      buildDashboardAuthBody();
    if (!bearerFromStorage || bearerFromStorage.split(".").length < 2) {
      setDashError("Sign in with Visaflow dashboard OTP first.");
      return false;
    }
    setDashError(null);
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
      byPassport?: Record<string, DashboardMediaEntry & { passportImages?: Array<{ url: string }> }>;
      refreshedBearerJwt?: string;
    };
    if (!res.ok) {
      setDashError(json.error ?? `HTTP ${res.status}`);
      return false;
    }
    applyRefreshedBearerJwt(json.refreshedBearerJwt);
    setDashByPassport(json.byPassport ?? {});
    return true;
  }

  function applyPreset(interval: string) {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["24h"];
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    setFromStr(toDatetimeLocal(from));
    setToStr(toDatetimeLocal(to));
  }

  async function handleBuild() {
    setError(null);
    setReport(null);
    setDashByPassport({});
    setDashError(null);
    setLoading(true);
    const fromMs = new Date(fromStr).getTime();
    const toMs = new Date(toStr).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      setError("From must be before To.");
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
          solveKind: "drop",
          deploymentEnv,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as ReportPayload & { error?: string };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        setLoading(false);
        return;
      }
      setReport(json);
      const recovery = json.deniedRecoveryByEmail ?? {};
      const notRecovered = Object.values(recovery).filter((r) => !r.recoveredAfterLatestDenied);
      if (notRecovered.length === 0) {
        setLoading(false);
        return;
      }
      const passports = collectPassportsFromReportData({
        deniedPassportRows: json.deniedPassportRows,
      });
      const passportList = [
        ...new Set(
          (json.deniedPassportRows ?? [])
            .filter((r) => {
              const em = r.email.trim().toLowerCase();
              const rec = recovery[em];
              return rec && !rec.recoveredAfterLatestDenied && r.passportNumber?.trim();
            })
            .map((r) => r.passportNumber!.trim())
        ),
      ];
      if (passportList.length === 0 && passports.length > 0) {
        await fetchDashboardForPassports(passports);
      } else if (passportList.length > 0) {
        await fetchDashboardForPassports(passportList);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  const { jobs, skipped, notRecoveredEmails } = useMemo(() => {
    if (!report?.deniedRecoveryByEmail) {
      return { jobs: [] as StagingJob[], skipped: [] as SkippedApplicant[], notRecoveredEmails: [] as string[] };
    }
    return buildNotRecoveredStagingJobs({
      deniedRows: report.deniedPassportRows ?? [],
      recoveryByEmail: report.deniedRecoveryByEmail,
      dashByPassport,
    });
  }, [report, dashByPassport]);

  const batches = useMemo(() => chunkStagingJobs(jobs, STAGING_JOBS_BATCH_SIZE), [jobs]);
  const allBatchesJson = useMemo(() => JSON.stringify(batches, null, 2), [batches]);
  const allJobsJson = useMemo(
    () => JSON.stringify(batches.flatMap((b) => b.jobs), null, 2),
    [batches]
  );

  async function copyText(text: string, key: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      setCopiedKey(null);
    }
  }

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Unrecovered DENIED → staging JSON</h1>
        <p className="text-sm text-zinc-600 mt-1">
          DENIED idnfystatus with no later in-house pass in the window. Loads dashboard passport image + all applicant
          videos, then builds JSON batches of {STAGING_JOBS_BATCH_SIZE} jobs (
          <code className="text-xs">label</code>, <code className="text-xs">passportURL</code>,{" "}
          <code className="text-xs">videoUrl</code>) for <code className="text-xs">parrallel-test-session.js</code>.
        </p>
      </div>

      <VisaflowDashboardLoginPanel hint="Required before build. Stays signed in across pages and refresh." />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">From</label>
          <input
            type="datetime-local"
            value={fromStr}
            onChange={(e) => setFromStr(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">To</label>
          <input
            type="datetime-local"
            value={toStr}
            onChange={(e) => setToStr(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white"
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
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100"
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">Environment</label>
          <select
            value={deploymentEnv}
            onChange={(e) => setDeploymentEnv(e.target.value as DeploymentEnvUi)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white"
          >
            <option value="prod">Production</option>
            <option value="staging">Staging</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">Target app</label>
          <input
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={handleBuild}
        disabled={loading || !dashboardJwtSaved}
        className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {loading ? "Loading report + dashboard…" : "Build JSON batches"}
      </button>

      {error ? (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
      ) : null}
      {dashError ? (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-md px-3 py-2">{dashError}</p>
      ) : null}

      {report && (
        <div className="space-y-4">
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm">
            <div>
              Not recovered (email): <strong>{notRecoveredEmails.length}</strong> · Staging jobs (video×passport):{" "}
              <strong>{jobs.length}</strong> · Batches of {STAGING_JOBS_BATCH_SIZE}: <strong>{batches.length}</strong>
            </div>
            {skipped.length > 0 ? (
              <div className="mt-2 text-xs text-amber-900">
                Skipped {skipped.length} email/passport (no image, no video, or missing dashboard data)
              </div>
            ) : null}
          </div>

          {jobs.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => copyText(allJobsJson, "all-jobs")}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50"
              >
                {copiedKey === "all-jobs" ? "Copied" : "Copy all jobs (flat array)"}
              </button>
              <button
                type="button"
                onClick={() => copyText(allBatchesJson, "all-batches")}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50"
              >
                {copiedKey === "all-batches" ? "Copied" : "Copy all batch objects"}
              </button>
            </div>
          )}

          {batches.map((batch) => (
            <BatchCard
              key={batch.batch}
              batch={batch}
              copiedKey={copiedKey}
              onCopy={copyText}
            />
          ))}

          {skipped.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-zinc-800 mb-2">Skipped</h2>
              <div className="overflow-auto rounded-lg border border-zinc-200 max-h-48">
                <table className="min-w-full text-xs">
                  <thead className="bg-zinc-50">
                    <tr>
                      <th className="px-2 py-1 text-left">Email</th>
                      <th className="px-2 py-1 text-left">Passport</th>
                      <th className="px-2 py-1 text-left">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skipped.map((s, i) => (
                      <tr key={`${s.email}-${s.passportNumber ?? ""}-${i}`} className="border-t border-zinc-100">
                        <td className="px-2 py-1 font-mono">{s.email}</td>
                        <td className="px-2 py-1 font-mono">{s.passportNumber ?? "—"}</td>
                        <td className="px-2 py-1 text-zinc-600">{s.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {notRecoveredEmails.length === 0 && report.deniedRecoveryByEmail && (
            <p className="text-sm text-zinc-600">No DENIED applicants without in-house recovery in this window.</p>
          )}
        </div>
      )}
    </div>
  );
}

function BatchCard({
  batch,
  copiedKey,
  onCopy,
}: {
  batch: StagingJobBatch;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
}) {
  const jobsOnlyJson = JSON.stringify(batch.jobs, null, 2);
  const batchJson = JSON.stringify(batch, null, 2);
  const keyJobs = `batch-${batch.batch}-jobs`;
  const keyFull = `batch-${batch.batch}-full`;

  return (
    <div className="rounded-xl border border-zinc-200 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-zinc-100 px-3 py-2 border-b border-zinc-200">
        <span className="text-sm font-medium text-zinc-800">
          Batch {batch.batch} · {batch.count} job{batch.count === 1 ? "" : "s"}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onCopy(jobsOnlyJson, keyJobs)}
            className="text-xs rounded border border-zinc-300 px-2 py-1 bg-white hover:bg-zinc-50"
          >
            {copiedKey === keyJobs ? "Copied" : "Copy JOBS array"}
          </button>
          <button
            type="button"
            onClick={() => onCopy(batchJson, keyFull)}
            className="text-xs rounded border border-zinc-300 px-2 py-1 bg-white hover:bg-zinc-50"
          >
            {copiedKey === keyFull ? "Copied" : "Copy batch object"}
          </button>
        </div>
      </div>
      <pre className="text-[10px] font-mono p-3 overflow-auto max-h-64 bg-white text-zinc-800">{jobsOnlyJson}</pre>
    </div>
  );
}
