"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

const SS_BEARER_JWT = "ui-test-visaflow-dashboard-bearer-jwt";
const SS_CLERK_REFRESH_SESSION_ID = "ui-test-visaflow-clerk-refresh-session-id";
const SS_OTP_COOKIE_JAR = "ui-test-clerk-otp-cookie-jar";
const SS_OTP_SIA = "ui-test-clerk-sign-in-attempt-id";

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
  const [dashboardJwtSaved, setDashboardJwtSaved] = useState(false);
  const [otpEmail, setOtpEmail] = useState("");
  const [otpCookieJar, setOtpCookieJar] = useState("");
  const [otpSignInAttemptId, setOtpSignInAttemptId] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const refreshJwtFlag = useCallback(() => {
    try {
      setDashboardJwtSaved(Boolean(sessionStorage.getItem(SS_BEARER_JWT)?.trim()));
    } catch {
      setDashboardJwtSaved(false);
    }
  }, []);

  useEffect(() => {
    refreshJwtFlag();
    const onJwt = () => refreshJwtFlag();
    window.addEventListener("visaflow-jwt-updated", onJwt);
    window.addEventListener("focus", onJwt);
    try {
      const jar = sessionStorage.getItem(SS_OTP_COOKIE_JAR);
      const sia = sessionStorage.getItem(SS_OTP_SIA);
      if (jar) setOtpCookieJar(jar);
      if (sia) setOtpSignInAttemptId(sia);
    } catch {
      /* */
    }
    return () => {
      window.removeEventListener("visaflow-jwt-updated", onJwt);
      window.removeEventListener("focus", onJwt);
    };
  }, [refreshJwtFlag]);

  function applyPreset(interval: string) {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["24h"];
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    setFromStr(toDatetimeLocal(from));
    setToStr(toDatetimeLocal(to));
  }

  async function fetchDashboardForPassports(passportNumbers: string[]) {
    let bearerFromStorage = "";
    let refreshSid = "";
    let refreshJar = "";
    try {
      bearerFromStorage = sessionStorage.getItem(SS_BEARER_JWT)?.trim() ?? "";
      refreshSid = sessionStorage.getItem(SS_CLERK_REFRESH_SESSION_ID)?.trim() ?? "";
      refreshJar = sessionStorage.getItem(SS_OTP_COOKIE_JAR)?.trim() ?? "";
    } catch {
      /* */
    }
    if (!bearerFromStorage || bearerFromStorage.split(".").length < 2) {
      setDashError("Sign in with dashboard OTP first.");
      return false;
    }
    setDashError(null);
    const res = await fetch("/api/dashboard-passport-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        passportNumbers,
        bearerJwt: bearerFromStorage,
        ...(refreshSid.startsWith("sess_") ? { clerkSessionId: refreshSid } : {}),
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
    const nextJwt = typeof json.refreshedBearerJwt === "string" ? json.refreshedBearerJwt.trim() : "";
    if (nextJwt && nextJwt.split(".").length >= 2) {
      try {
        sessionStorage.setItem(SS_BEARER_JWT, nextJwt);
      } catch {
        /* */
      }
    }
    setDashByPassport(json.byPassport ?? {});
    return true;
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

  function parseOtpJsonResponse(text: string): Record<string, unknown> {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { error: text.slice(0, 800) || "Invalid JSON" };
    }
  }

  async function sendClerkOtp() {
    setOtpError(null);
    const email = otpEmail.trim();
    if (!email.includes("@")) {
      setOtpError("Enter a valid email.");
      return;
    }
    setOtpLoading(true);
    try {
      const res = await fetch("/api/clerk-email-signin/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const otpData = parseOtpJsonResponse(await res.text());
      if (!res.ok) {
        setOtpError(typeof otpData.error === "string" ? otpData.error : `HTTP ${res.status}`);
        return;
      }
      const signInAttemptId = typeof otpData.signInAttemptId === "string" ? otpData.signInAttemptId : "";
      const cookieJar = typeof otpData.cookieJar === "string" ? otpData.cookieJar : "";
      if (!signInAttemptId || !cookieJar) {
        setOtpError("Missing signInAttemptId or cookieJar");
        return;
      }
      setOtpSignInAttemptId(signInAttemptId);
      setOtpCookieJar(cookieJar);
      sessionStorage.setItem(SS_OTP_SIA, signInAttemptId);
      sessionStorage.setItem(SS_OTP_COOKIE_JAR, cookieJar);
    } catch (e: unknown) {
      setOtpError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setOtpLoading(false);
    }
  }

  async function verifyClerkOtp() {
    setOtpError(null);
    const sia = otpSignInAttemptId.trim();
    const jar = otpCookieJar.trim();
    const code = otpCode.trim().replace(/\s+/g, "");
    if (!sia.startsWith("sia_")) {
      setOtpError("Send the email code first.");
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setOtpError("Enter the 6-digit code.");
      return;
    }
    setOtpLoading(true);
    try {
      const res = await fetch("/api/clerk-email-signin/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signInAttemptId: sia, code, cookieJar: jar }),
      });
      const otpData = parseOtpJsonResponse(await res.text());
      if (!res.ok) {
        setOtpError(typeof otpData.error === "string" ? otpData.error : `HTTP ${res.status}`);
        return;
      }
      const jwt = typeof otpData.jwt === "string" ? otpData.jwt.trim() : "";
      if (!jwt) {
        setOtpError("No JWT in response");
        return;
      }
      sessionStorage.setItem(SS_BEARER_JWT, jwt);
      const sid = typeof otpData.sessionId === "string" ? otpData.sessionId.trim() : "";
      if (sid.startsWith("sess_")) sessionStorage.setItem(SS_CLERK_REFRESH_SESSION_ID, sid);
      setDashboardJwtSaved(true);
      setOtpCode("");
      window.dispatchEvent(new Event("visaflow-jwt-updated"));
    } catch (e: unknown) {
      setOtpError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setOtpLoading(false);
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

      <div className="rounded-lg border border-emerald-200 bg-emerald-50/80 px-4 py-3 space-y-3">
        <p className="text-sm font-medium text-zinc-800">Dashboard OTP</p>
        {dashboardJwtSaved ? (
          <span className="text-xs text-emerald-800 font-medium">JWT saved</span>
        ) : (
          <span className="text-xs text-zinc-500">Required before build</span>
        )}
        {otpError ? <pre className="text-[11px] text-red-800 whitespace-pre-wrap">{otpError}</pre> : null}
        <div className="flex flex-wrap gap-2 items-end">
          <input
            type="email"
            value={otpEmail}
            onChange={(e) => setOtpEmail(e.target.value)}
            placeholder="Email"
            className="flex-1 min-w-[180px] rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white"
          />
          <button
            type="button"
            onClick={sendClerkOtp}
            disabled={otpLoading}
            className="rounded-lg bg-emerald-800 px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            Send code
          </button>
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={otpCode}
            onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="6-digit"
            className="w-24 rounded-lg border border-zinc-300 px-2 py-2 text-sm font-mono"
          />
          <button
            type="button"
            onClick={verifyClerkOtp}
            disabled={otpLoading}
            className="rounded-lg border border-emerald-700 px-3 py-2 text-sm"
          >
            Verify
          </button>
        </div>
      </div>

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
