"use client";

import { useEffect, useMemo, useState } from "react";

const SS_CLERK_SESSION = "ui-test-visaflow-clerk-session";
const SS_CLERK_COOKIE = "ui-test-visaflow-clerk-cookie";
const SS_ORG_ID = "ui-test-visaflow-org-id";
const SS_BEARER_JWT = "ui-test-visaflow-dashboard-bearer-jwt";
const SS_CLERK_REFRESH_SESSION_ID = "ui-test-visaflow-clerk-refresh-session-id";
const SS_OTP_COOKIE_JAR = "ui-test-clerk-otp-cookie-jar";
const SS_OTP_SIA = "ui-test-clerk-sign-in-attempt-id";
const SS_CLIENT_WAIT_STATUS = "ui-test-processing-client-wait-status";
const SS_LAST_STATUS_UPDATE_FROM = "ui-test-processing-last-status-update-from";
const SS_LAST_STATUS_UPDATE_TO = "ui-test-processing-last-status-update-to";
/** @deprecated migrated to FROM key */
const SS_LAST_STATUS_UPDATE_AFTER = "ui-test-processing-last-status-update-after";

const CLIENT_WAIT_STATUS_PRESETS = [
  { value: "pending_applicant", label: "Pending applicant" },
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "error", label: "Error" },
] as const;

const DEFAULT_REDIS_URL = process.env.NEXT_PUBLIC_DEFAULT_REDIS_URL ?? "";
const DEFAULT_SESSION_API_URL = process.env.NEXT_PUBLIC_DEFAULT_SESSION_API_URL ?? "";
const STAGING_STREAM_KEY = "azure:identity-verification:stream:prod";

type SubmitState = "idle" | "loading" | "success" | "error";
type SubmitResult = { sessionId?: string; messageId?: string; error?: string };

type ApplicantVideoRow = {
  clientId: string;
  applicantId: string;
  firstName: string;
  lastName: string;
  passportNumber: string;
  passportImageUrl: string;
  clientStatus: string;
  identityVerificationStatus: string;
  fromCountry: string;
  toCountry: string;
  videos: string[];
};

type Totals = {
  clientsScanned: number;
  clientsMatchedCountry: number;
  clientWaitStatus?: string;
  lastStatusUpdateAfter?: string | null;
  lastStatusUpdateBefore?: string | null;
  statusMatchedClients?: number;
  clientsAfterLastStatusUpdateFilter?: number;
  /** @deprecated use statusMatchedClients */
  pendingClients: number;
  applicantsFound: number;
  applicantsWithVideos: number;
  applicantsWithoutVideos: number;
  completedIdentityApplicantsTotal?: number;
  targetLimit?: number;
  matchedApplicantsReturned?: number;
  completedIdentityApplicantsScanned?: number;
  stoppedEarly?: boolean;
  stopReason?: "scan_cap" | "exhausted" | null;
};

type ApiResponse = {
  totals: Totals;
  rows: ApplicantVideoRow[];
  refreshedBearerJwt?: string;
  error?: string;
};

export default function ProcessingApplicantVideosClient() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [applicantLimit, setApplicantLimit] = useState("50");
  const [clientWaitStatus, setClientWaitStatus] = useState("pending_applicant");
  const [clientWaitStatusCustom, setClientWaitStatusCustom] = useState("");
  const [lastStatusUpdateFrom, setLastStatusUpdateFrom] = useState("");
  const [lastStatusUpdateTo, setLastStatusUpdateTo] = useState("");
  const [expandedVideo, setExpandedVideo] = useState<string | null>(null);
  const [parallelJobsCopied, setParallelJobsCopied] = useState(false);
  const [videoOnlyJobsCopied, setVideoOnlyJobsCopied] = useState(false);
  const [allVideosJobsCopied, setAllVideosJobsCopied] = useState(false);

  // key: `${applicantId}-${videoIndex}` → submit state
  const [submitStates, setSubmitStates] = useState<Record<string, SubmitState>>({});
  const [submitResults, setSubmitResults] = useState<Record<string, SubmitResult>>({});

  const [clerkSessionId, setClerkSessionId] = useState("");
  const [clerkCookie, setClerkCookie] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [dashboardJwtSaved, setDashboardJwtSaved] = useState(false);
  const [otpEmail, setOtpEmail] = useState("");
  const [otpCookieJar, setOtpCookieJar] = useState("");
  const [otpSignInAttemptId, setOtpSignInAttemptId] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpWarning, setOtpWarning] = useState<string | null>(null);

  function parseOtpJsonResponse(text: string): Record<string, unknown> {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { error: text.slice(0, 800) || "Empty or invalid JSON from server" };
    }
  }

  function formatOtpFailure(res: Response, data: Record<string, unknown>): string {
    const lines: string[] = [`HTTP ${res.status}`];
    if (typeof data.error === "string" && data.error.trim()) lines.push(data.error.trim());
    if (typeof data.clerkHttpStatus === "number" && data.clerkHttpStatus !== res.status) {
      lines.push(`Clerk HTTP: ${data.clerkHttpStatus}`);
    }
    if (typeof data.clerkSignInStatus === "string") lines.push(`Clerk sign_in status: ${data.clerkSignInStatus}`);
    if (typeof data.clerkDebug === "string" && data.clerkDebug.trim()) lines.push(data.clerkDebug.trim());
    return lines.join("\n\n");
  }

  useEffect(() => {
    try {
      const s = sessionStorage.getItem(SS_CLERK_SESSION);
      const c = sessionStorage.getItem(SS_CLERK_COOKIE);
      const o = sessionStorage.getItem(SS_ORG_ID);
      if (s) setClerkSessionId(s);
      if (c) setClerkCookie(c);
      if (o) setOrganizationId(o);
      setDashboardJwtSaved(Boolean(sessionStorage.getItem(SS_BEARER_JWT)?.trim()));
      const jar = sessionStorage.getItem(SS_OTP_COOKIE_JAR);
      const sia = sessionStorage.getItem(SS_OTP_SIA);
      if (jar) setOtpCookieJar(jar);
      if (sia) setOtpSignInAttemptId(sia);
      const waitSt = sessionStorage.getItem(SS_CLIENT_WAIT_STATUS);
      if (waitSt) setClientWaitStatus(waitSt);
      const lsFrom =
        sessionStorage.getItem(SS_LAST_STATUS_UPDATE_FROM) ??
        sessionStorage.getItem(SS_LAST_STATUS_UPDATE_AFTER);
      if (lsFrom) setLastStatusUpdateFrom(lsFrom);
      const lsTo = sessionStorage.getItem(SS_LAST_STATUS_UPDATE_TO);
      if (lsTo) setLastStatusUpdateTo(lsTo);
    } catch {
      /* private mode */
    }
  }, []);

  const effectiveClientWaitStatus = useMemo(() => {
    if (clientWaitStatus === "custom") {
      return clientWaitStatusCustom.trim().toLowerCase() || "pending_applicant";
    }
    return clientWaitStatus.trim().toLowerCase() || "pending_applicant";
  }, [clientWaitStatus, clientWaitStatusCustom]);

  function clearDashboardJwt() {
    try {
      sessionStorage.removeItem(SS_BEARER_JWT);
      sessionStorage.removeItem(SS_CLERK_REFRESH_SESSION_ID);
    } catch {
      /* */
    }
    setDashboardJwtSaved(false);
  }

  async function sendClerkOtp() {
    setOtpError(null);
    setOtpWarning(null);
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
      const text = await res.text();
      const otpData = parseOtpJsonResponse(text);
      if (!res.ok) {
        setOtpError(formatOtpFailure(res, otpData));
        return;
      }
      const signInAttemptId = typeof otpData.signInAttemptId === "string" ? otpData.signInAttemptId : "";
      const cookieJar = typeof otpData.cookieJar === "string" ? otpData.cookieJar : "";
      if (!signInAttemptId || !cookieJar) {
        setOtpError(formatOtpFailure(res, { ...otpData, error: "Missing signInAttemptId or cookieJar in success body" }));
        return;
      }
      const warn = typeof otpData.warning === "string" ? otpData.warning.trim() : "";
      const prepared = otpData.prepareFirstFactorOk === true;
      setOtpWarning(
        warn
          ? warn
          : prepared
            ? "Clerk prepare_first_factor succeeded — check inbox and spam for the 6-digit code."
            : null,
      );
      setOtpSignInAttemptId(signInAttemptId);
      setOtpCookieJar(cookieJar);
      try {
        sessionStorage.setItem(SS_OTP_COOKIE_JAR, cookieJar);
        sessionStorage.setItem(SS_OTP_SIA, signInAttemptId);
      } catch {
        /* */
      }
    } catch (e: unknown) {
      setOtpError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setOtpLoading(false);
    }
  }

  async function verifyClerkOtp() {
    setOtpError(null);
    setOtpWarning(null);
    const sia = otpSignInAttemptId.trim();
    const jar = otpCookieJar.trim();
    const code = otpCode.trim().replace(/\s+/g, "");
    if (!sia.startsWith("sia_")) {
      setOtpError("Send the email code first (no sign-in attempt id).");
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setOtpError("Enter the 6-digit code from email.");
      return;
    }
    if (!jar) {
      setOtpError("Missing cookie jar — send code again.");
      return;
    }
    setOtpLoading(true);
    try {
      const res = await fetch("/api/clerk-email-signin/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signInAttemptId: sia, code, cookieJar: jar }),
      });
      const text = await res.text();
      const otpData = parseOtpJsonResponse(text);
      if (!res.ok) {
        setOtpError(formatOtpFailure(res, otpData));
        return;
      }
      const jwt = typeof otpData.jwt === "string" ? otpData.jwt : "";
      if (!jwt) {
        setOtpError(formatOtpFailure(res, { ...otpData, error: "No jwt in verify response body" }));
        return;
      }
      try {
        sessionStorage.setItem(SS_BEARER_JWT, jwt);
        const nextJar = typeof otpData.cookieJar === "string" ? otpData.cookieJar : "";
        if (nextJar) {
          sessionStorage.setItem(SS_OTP_COOKIE_JAR, nextJar);
          setOtpCookieJar(nextJar);
        }
        const sid = typeof otpData.sessionId === "string" ? otpData.sessionId.trim() : "";
        if (sid.startsWith("sess_")) {
          sessionStorage.setItem(SS_CLERK_REFRESH_SESSION_ID, sid);
        }
      } catch {
        /* */
      }
      setDashboardJwtSaved(true);
      setOtpCode("");
    } catch (e: unknown) {
      setOtpError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setOtpLoading(false);
    }
  }

  async function handleLoad() {
    setError(null);
    setData(null);
    const fromRaw = lastStatusUpdateFrom.trim();
    const toRaw = lastStatusUpdateTo.trim();
    const fromMs = fromRaw ? Date.parse(fromRaw) : NaN;
    const toMs = toRaw ? Date.parse(toRaw) : NaN;
    if (fromRaw && !Number.isFinite(fromMs)) {
      setError("Invalid “from” date.");
      return;
    }
    if (toRaw && !Number.isFinite(toMs)) {
      setError("Invalid “to” date.");
      return;
    }
    if (fromRaw && toRaw && Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs > toMs) {
      setError("From must be before To (use valid date-time).");
      return;
    }
    setLoading(true);
    try {
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
      const useBearer = Boolean(bearerFromStorage && bearerFromStorage.split(".").length >= 2);
      const limit = parseInt(applicantLimit, 10);
      try {
        sessionStorage.setItem(SS_CLIENT_WAIT_STATUS, clientWaitStatus);
        if (fromRaw) {
          sessionStorage.setItem(SS_LAST_STATUS_UPDATE_FROM, fromRaw);
        } else {
          sessionStorage.removeItem(SS_LAST_STATUS_UPDATE_FROM);
          sessionStorage.removeItem(SS_LAST_STATUS_UPDATE_AFTER);
        }
        if (toRaw) {
          sessionStorage.setItem(SS_LAST_STATUS_UPDATE_TO, toRaw);
        } else {
          sessionStorage.removeItem(SS_LAST_STATUS_UPDATE_TO);
        }
      } catch {
        /* */
      }
      const lastStatusFromIso =
        fromRaw && Number.isFinite(fromMs) ? new Date(fromMs).toISOString() : "";
      const lastStatusToIso = toRaw && Number.isFinite(toMs) ? new Date(toMs).toISOString() : "";
      const res = await fetch("/api/processing-applicant-videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          useBearer
            ? {
                bearerJwt: bearerFromStorage,
                limit: isNaN(limit) || limit <= 0 ? 50 : limit,
                clientWaitStatus: effectiveClientWaitStatus,
                ...(lastStatusFromIso ? { lastStatusUpdateAfter: lastStatusFromIso } : {}),
                ...(lastStatusToIso ? { lastStatusUpdateBefore: lastStatusToIso } : {}),
                ...(refreshSid?.startsWith("sess_") ? { clerkSessionId: refreshSid } : {}),
                ...(refreshJar ? { clerkCookie: refreshJar } : {}),
              }
            : {
                limit: isNaN(limit) || limit <= 0 ? 50 : limit,
                clientWaitStatus: effectiveClientWaitStatus,
                ...(lastStatusFromIso ? { lastStatusUpdateAfter: lastStatusFromIso } : {}),
                ...(lastStatusToIso ? { lastStatusUpdateBefore: lastStatusToIso } : {}),
                ...(clerkSessionId.trim() ? { clerkSessionId: clerkSessionId.trim() } : {}),
                ...(clerkCookie.trim() ? { clerkCookie: clerkCookie.trim() } : {}),
                ...(organizationId.trim() ? { organizationId: organizationId.trim() } : {}),
              },
        ),
      });
      const json = (await res.json().catch(() => ({}))) as ApiResponse;
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      if (typeof json.refreshedBearerJwt === "string" && json.refreshedBearerJwt.trim()) {
        try {
          sessionStorage.setItem(SS_BEARER_JWT, json.refreshedBearerJwt.trim());
        } catch {
          /* */
        }
      }
      setData(json);
      try {
        if (clerkSessionId.trim()) sessionStorage.setItem(SS_CLERK_SESSION, clerkSessionId.trim());
        if (clerkCookie.trim()) sessionStorage.setItem(SS_CLERK_COOKIE, clerkCookie.trim());
        sessionStorage.setItem(SS_ORG_ID, organizationId.trim());
      } catch {
        /* */
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  const parallelJobsJson = useMemo(() => {
    if (!data?.rows) return "";
    type Job = { label: string; passportURL: string; videoUrl: string };
    const jobs: Job[] = [];
    for (const row of data.rows) {
      const passportURL = (row.passportImageUrl ?? "").trim();
      const firstVideo =
        row.videos.map((u) => (typeof u === "string" ? u.trim() : "")).find((v) => v.length > 0) ?? "";
      if (!passportURL || !firstVideo) continue;
      const label = row.passportNumber.trim() || "UNKNOWN";
      jobs.push({ label, passportURL, videoUrl: firstVideo });
    }
    return JSON.stringify(jobs, null, 2);
  }, [data]);

  const videoOnlyJobsJson = useMemo(() => {
    if (!data?.rows) return "";
    type VideoJob = { label: string; videoUrl: string };
    const jobs: VideoJob[] = [];
    for (const row of data.rows) {
      const firstVideo =
        row.videos.map((u) => (typeof u === "string" ? u.trim() : "")).find((v) => v.length > 0) ?? "";
      if (!firstVideo) continue;
      const label = row.passportNumber.trim() || "UNKNOWN";
      jobs.push({ label, videoUrl: firstVideo });
    }
    return JSON.stringify(jobs, null, 2);
  }, [data]);

  const allVideosJobsJson = useMemo(() => {
    if (!data?.rows) return "";
    type Job = { label: string; passportURL: string; videoUrl: string };
    const jobs: Job[] = [];
    for (const row of data.rows) {
      const passportURL = (row.passportImageUrl ?? "").trim();
      const videos = row.videos
        .map((u) => (typeof u === "string" ? u.trim() : ""))
        .filter((v) => v.length > 0);
      if (!passportURL || videos.length === 0) continue;
      const baseLabel = row.passportNumber.trim() || "UNKNOWN";
      videos.forEach((videoUrl, i) => {
        const label = videos.length > 1 ? `${baseLabel}-v${i + 1}` : baseLabel;
        jobs.push({ label, passportURL, videoUrl });
      });
    }
    return JSON.stringify(jobs, null, 2);
  }, [data]);

  async function copyParallelJobsJson() {
    if (!parallelJobsJson) return;
    try {
      await navigator.clipboard.writeText(parallelJobsJson);
      setParallelJobsCopied(true);
      setTimeout(() => setParallelJobsCopied(false), 1500);
    } catch {
      setParallelJobsCopied(false);
    }
  }

  async function copyVideoOnlyJobsJson() {
    if (!videoOnlyJobsJson) return;
    try {
      await navigator.clipboard.writeText(videoOnlyJobsJson);
      setVideoOnlyJobsCopied(true);
      setTimeout(() => setVideoOnlyJobsCopied(false), 1500);
    } catch {
      setVideoOnlyJobsCopied(false);
    }
  }

  async function copyAllVideosJobsJson() {
    if (!allVideosJobsJson) return;
    try {
      await navigator.clipboard.writeText(allVideosJobsJson);
      setAllVideosJobsCopied(true);
      setTimeout(() => setAllVideosJobsCopied(false), 1500);
    } catch {
      setAllVideosJobsCopied(false);
    }
  }

  async function submitToStaging(videoUrl: string, key: string) {
    setSubmitStates((prev) => ({ ...prev, [key]: "loading" }));
    setSubmitResults((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const res = await fetch("/api/run-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redisUrl: DEFAULT_REDIS_URL,
          sessionApiUrl: DEFAULT_SESSION_API_URL,
          streamKey: STAGING_STREAM_KEY,
          videoUrls: [videoUrl],
          repetitions: 1,
          isFirstVerification: false,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { results?: Array<{ success: boolean; sessionId?: string; messageId?: string; error?: string }> };
      const first = json.results?.[0];
      if (!res.ok || !first?.success) {
        setSubmitStates((prev) => ({ ...prev, [key]: "error" }));
        setSubmitResults((prev) => ({ ...prev, [key]: { error: first?.error ?? `HTTP ${res.status}` } }));
      } else {
        setSubmitStates((prev) => ({ ...prev, [key]: "success" }));
        setSubmitResults((prev) => ({ ...prev, [key]: { sessionId: first.sessionId, messageId: first.messageId } }));
      }
    } catch (e: unknown) {
      setSubmitStates((prev) => ({ ...prev, [key]: "error" }));
      setSubmitResults((prev) => ({ ...prev, [key]: { error: e instanceof Error ? e.message : "Request failed" } }));
    }
  }

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Processing applicant videos</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Uses clients on <strong>any route</strong> whose <strong>client</strong> status matches your selection below. Loads up to
          your <strong>target</strong> count of applicants with <strong>identity</strong>{" "}
          <code>completed</code> who have both a <strong>passport image</strong> and <strong>video</strong>. Eligible
          applicants are <strong>shuffled</strong> each request, then scanned in batches until the target is met or the
          pool/cap is exhausted (so two runs with the same target usually differ when enough people qualify).
        </p>
      </div>

      {/* OTP login */}
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/80 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-zinc-800">Visaflow sign-in (email OTP)</p>
          {dashboardJwtSaved ? (
            <span className="text-xs font-medium text-emerald-800">Dashboard JWT saved</span>
          ) : (
            <span className="text-xs text-zinc-500">No JWT yet — complete OTP below</span>
          )}
        </div>
        {otpError ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
            <p className="text-xs font-semibold text-red-900 mb-1">Clerk / sign-in error</p>
            <pre className="text-[11px] text-red-900 whitespace-pre-wrap break-words font-mono max-h-64 overflow-y-auto">
              {otpError}
            </pre>
          </div>
        ) : null}
        {otpWarning ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
            <p className="text-xs font-semibold text-amber-900 mb-1">Notice</p>
            <p className="text-xs text-amber-950">{otpWarning}</p>
          </div>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Email</label>
            <input
              type="email"
              value={otpEmail}
              onChange={(e) => setOtpEmail(e.target.value)}
              autoComplete="email"
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900"
            />
          </div>
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={sendClerkOtp}
              disabled={otpLoading}
              className="rounded-lg bg-emerald-800 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-900 disabled:opacity-50"
            >
              {otpLoading ? "…" : "Send code"}
            </button>
            {dashboardJwtSaved ? (
              <button
                type="button"
                onClick={clearDashboardJwt}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs text-zinc-700 hover:bg-zinc-50"
              >
                Clear JWT
              </button>
            ) : null}
          </div>
        </div>
        {otpSignInAttemptId ? (
          <p className="text-[11px] text-zinc-500 font-mono break-all">Attempt: {otpSignInAttemptId}</p>
        ) : null}
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[140px]">
            <label className="block text-xs font-medium text-zinc-700 mb-1">Email code</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="6 digits"
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm font-mono tracking-widest bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900"
            />
          </div>
          <button
            type="button"
            onClick={verifyClerkOtp}
            disabled={otpLoading}
            className="rounded-lg border border-emerald-700 bg-white px-3 py-2 text-sm font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
          >
            Verify code
          </button>
        </div>
      </div>

      {/* Advanced manual session */}
      <details className="rounded-lg border border-amber-200 bg-amber-50/80 px-4 py-3 space-y-3 group">
        <summary className="cursor-pointer text-sm font-medium text-zinc-800 list-none flex items-center gap-2 [&::-webkit-details-marker]:hidden">
          <span className="text-zinc-500 group-open:hidden">▶</span>
          <span className="hidden group-open:inline">▼</span>
          Advanced: manual Clerk session (optional)
        </summary>
        <div className="pt-2 space-y-3">
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Clerk session id</label>
            <input
              type="text"
              value={clerkSessionId}
              onChange={(e) => setClerkSessionId(e.target.value)}
              placeholder="sess_…"
              autoComplete="off"
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Cookie header value</label>
            <textarea
              value={clerkCookie}
              onChange={(e) => setClerkCookie(e.target.value)}
              placeholder="__client=…; __session=…; __client_uat=…"
              rows={3}
              autoComplete="off"
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-xs font-mono bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Organization id (optional)</label>
            <input
              type="text"
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
              autoComplete="off"
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900"
            />
          </div>
        </div>
      </details>

      {/* Limit + fetch */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-zinc-700 mb-1">Client wait status</label>
          <select
            value={clientWaitStatus}
            onChange={(e) => setClientWaitStatus(e.target.value)}
            className="w-44 rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900"
          >
            {CLIENT_WAIT_STATUS_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </div>
        {clientWaitStatus === "custom" ? (
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Custom status</label>
            <input
              type="text"
              value={clientWaitStatusCustom}
              onChange={(e) => setClientWaitStatusCustom(e.target.value)}
              placeholder="e.g. pending_applicant"
              className="w-48 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900"
            />
          </div>
        ) : (
          <p className="text-xs text-zinc-500 pb-2 font-mono">
            API: <code>{effectiveClientWaitStatus}</code>
          </p>
        )}
        <div>
          <label className="block text-xs font-medium text-zinc-700 mb-1">
            Last status update from
          </label>
          <input
            type="datetime-local"
            value={lastStatusUpdateFrom}
            onChange={(e) => setLastStatusUpdateFrom(e.target.value)}
            className="w-52 rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-700 mb-1">
            Last status update to
          </label>
          <input
            type="datetime-local"
            value={lastStatusUpdateTo}
            onChange={(e) => setLastStatusUpdateTo(e.target.value)}
            className="w-52 rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900"
          />
          <p className="text-[10px] text-zinc-500 mt-0.5">Leave either empty for open-ended range</p>
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-700 mb-1">
            Target (identity completed + passport + video)
          </label>
          <input
            type="number"
            min="1"
            max="500"
            value={applicantLimit}
            onChange={(e) => setApplicantLimit(e.target.value)}
            className="w-28 rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900"
          />
        </div>
        <button
          type="button"
          onClick={handleLoad}
          disabled={loading}
          className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? "Loading..." : "Fetch videos"}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>}

      {data && (
        <div className="space-y-4">
          {/* Totals */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="text-xs text-zinc-500">Clients scanned</p>
              <p className="text-lg font-semibold">{data.totals.clientsScanned}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="text-xs text-zinc-500">
                Status <code className="text-[10px]">{data.totals.clientWaitStatus ?? effectiveClientWaitStatus}</code>
              </p>
              <p className="text-lg font-semibold">
                {data.totals.statusMatchedClients ?? data.totals.pendingClients}
              </p>
            </div>
            {(data.totals.lastStatusUpdateAfter || data.totals.lastStatusUpdateBefore) ? (
              <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2">
                <p className="text-xs text-sky-800">Last status update range</p>
                <p className="text-sm font-semibold tabular-nums">
                  {data.totals.clientsAfterLastStatusUpdateFilter ?? "—"} clients
                </p>
                <p className="text-[10px] text-sky-700 font-mono mt-0.5">
                  {data.totals.lastStatusUpdateAfter
                    ? `≥ ${new Date(data.totals.lastStatusUpdateAfter).toLocaleString()}`
                    : "≥ (any)"}
                  {" · "}
                  {data.totals.lastStatusUpdateBefore
                    ? `≤ ${new Date(data.totals.lastStatusUpdateBefore).toLocaleString()}`
                    : "≤ (any)"}
                </p>
              </div>
            ) : null}
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="text-xs text-zinc-500">Applicants (on status-matched clients)</p>
              <p className="text-lg font-semibold">{data.totals.applicantsFound}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="text-xs text-zinc-500">Completed identity (applicants)</p>
              <p className="text-lg font-semibold">{data.totals.completedIdentityApplicantsTotal ?? "—"}</p>
            </div>
            <div
              className={`rounded-lg border px-3 py-2 ${
                (data.totals.matchedApplicantsReturned ?? data.rows.length) >= (data.totals.targetLimit ?? 0)
                  ? "border-emerald-200 bg-emerald-50"
                  : "border-amber-200 bg-amber-50"
              }`}
            >
              <p className={`text-xs ${(data.totals.matchedApplicantsReturned ?? data.rows.length) >= (data.totals.targetLimit ?? 0) ? "text-emerald-800" : "text-amber-800"}`}>
                Matched / target
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {data.totals.matchedApplicantsReturned ?? data.rows.length} / {data.totals.targetLimit ?? "—"}
              </p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="text-xs text-zinc-500">Completed-identity image scans</p>
              <p className="text-lg font-semibold">{data.totals.completedIdentityApplicantsScanned ?? "—"}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="text-xs text-zinc-500">Table rows (same as JSON)</p>
              <p className="text-lg font-semibold">{data.rows.length}</p>
            </div>
          </div>

          {data.totals.stoppedEarly ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
              {data.totals.stopReason === "scan_cap" ? (
                <p>
                  Stopped before reaching the target: image fetch cap reached (
                  <code className="text-xs">min(3000, max(150, 40×target))</code> completed-identity applicants). Raise the
                  target only if you accept more scanning, or reduce the target.
                </p>
              ) : (
                <p>
                  Fewer matching rows than target: not enough applicants with identity{" "}
                  <code className="text-zinc-800">completed</code>, passport image, and video in the scanned range.
                </p>
              )}
            </div>
          ) : null}

          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900">Parallel test jobs (JSON)</h2>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Same shape as <code className="text-zinc-700">azure-liveness-automation/parrallel-test-session.js</code>{" "}
                  <code className="text-zinc-700">JOBS</code> — matches returned table rows (client{" "}
                  <code className="text-zinc-700">{data.totals.clientWaitStatus ?? effectiveClientWaitStatus}</code>, identity{" "}
                  <code className="text-zinc-700">completed</code>,
                  passport image + video; first video each): <code className="text-zinc-700">label</code>,{" "}
                  <code className="text-zinc-700">passportURL</code>, <code className="text-zinc-700">videoUrl</code>. Paste
                  after <code className="text-zinc-700">const JOBS = </code>.
                </p>
              </div>
              <button
                type="button"
                onClick={copyParallelJobsJson}
                disabled={!parallelJobsJson}
                className="shrink-0 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-50"
              >
                {parallelJobsCopied ? "Copied" : "Copy JSON"}
              </button>
            </div>
            <textarea
              readOnly
              value={parallelJobsJson || "[]"}
              rows={Math.min(18, Math.max(6, (parallelJobsJson.split("\n").length || 1) + 1))}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-[11px] font-mono text-zinc-900 leading-relaxed focus:outline-none focus:ring-2 focus:ring-zinc-400 resize-y min-h-[8rem]"
              spellCheck={false}
            />
          </div>

          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900">Video-only jobs (JSON)</h2>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Same rows, first video each — <code className="text-zinc-700">label</code> +{" "}
                  <code className="text-zinc-700">videoUrl</code> only (no passport). For liveness-only runs without
                  face-verify passport image.
                </p>
              </div>
              <button
                type="button"
                onClick={copyVideoOnlyJobsJson}
                disabled={!videoOnlyJobsJson}
                className="shrink-0 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-50"
              >
                {videoOnlyJobsCopied ? "Copied" : "Copy JSON"}
              </button>
            </div>
            <textarea
              readOnly
              value={videoOnlyJobsJson || "[]"}
              rows={Math.min(18, Math.max(6, (videoOnlyJobsJson.split("\n").length || 1) + 1))}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-[11px] font-mono text-zinc-900 leading-relaxed focus:outline-none focus:ring-2 focus:ring-zinc-400 resize-y min-h-[8rem]"
              spellCheck={false}
            />
          </div>

          <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-4 py-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900">All videos jobs (JSON)</h2>
                <p className="text-xs text-zinc-500 mt-0.5">
                  One job per video — applicants with multiple videos appear multiple times (
                  <code className="text-zinc-700">label</code> suffix <code className="text-zinc-700">-v2</code>,{" "}
                  <code className="text-zinc-700">-v3</code>, …). Same{" "}
                  <code className="text-zinc-700">passportURL</code> + <code className="text-zinc-700">videoUrl</code>{" "}
                  shape as parallel JOBS.
                </p>
              </div>
              <button
                type="button"
                onClick={copyAllVideosJobsJson}
                disabled={!allVideosJobsJson}
                className="shrink-0 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-50"
              >
                {allVideosJobsCopied ? "Copied" : "Copy JSON"}
              </button>
            </div>
            <textarea
              readOnly
              value={allVideosJobsJson || "[]"}
              rows={Math.min(18, Math.max(6, (allVideosJobsJson.split("\n").length || 1) + 1))}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-[11px] font-mono text-zinc-900 leading-relaxed focus:outline-none focus:ring-2 focus:ring-zinc-400 resize-y min-h-[8rem]"
              spellCheck={false}
            />
          </div>

          {/* Table */}
          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
            <table className="min-w-full text-xs">
              <thead className="bg-zinc-100 text-zinc-800">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Applicant</th>
                  <th className="px-3 py-2 text-left font-semibold">Passport</th>
                  <th className="px-3 py-2 text-left font-semibold">Applicant ID</th>
                  <th className="px-3 py-2 text-left font-semibold">Client ID</th>
                  <th className="px-3 py-2 text-left font-semibold">Identity status</th>
                  <th className="px-3 py-2 text-left font-semibold">Videos</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-4 text-zinc-500">
                      No applicants found.
                    </td>
                  </tr>
                ) : (
                  data.rows.map((row) => (
                    <tr key={`${row.clientId}|${row.applicantId}`} className="border-t border-zinc-100 align-top">
                      <td className="px-3 py-2 font-medium text-zinc-900">
                        {[row.firstName, row.lastName].filter(Boolean).join(" ").trim() || "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-zinc-600">{row.passportNumber || "—"}</td>
                      <td className="px-3 py-2 font-mono text-zinc-700">{row.applicantId}</td>
                      <td className="px-3 py-2 font-mono text-zinc-700">{row.clientId}</td>
                      <td className="px-3 py-2">{row.identityVerificationStatus || "—"}</td>
                      <td className="px-3 py-2">
                        {row.videos.length === 0 ? (
                          <span className="text-red-600 font-medium">No videos</span>
                        ) : (
                          <div className="space-y-1">
                            {row.videos.map((url, i) => {
                              const key = `${row.applicantId}-${i}`;
                              const isExpanded = expandedVideo === key;
                              const submitState = submitStates[key] ?? "idle";
                              const submitResult = submitResults[key];
                              return (
                                <div key={key} className="space-y-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-emerald-700 font-medium">
                                      Video {i + 1}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => setExpandedVideo(isExpanded ? null : key)}
                                      className="text-[11px] text-zinc-500 underline hover:text-zinc-800"
                                    >
                                      {isExpanded ? "hide" : "play"}
                                    </button>
                                    <a
                                      href={url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-[11px] text-blue-600 underline hover:text-blue-800"
                                    >
                                      open
                                    </a>
                                    <button
                                      type="button"
                                      disabled={submitState === "loading"}
                                      onClick={() => submitToStaging(url, key)}
                                      className={`text-[11px] px-2 py-0.5 rounded font-medium border transition-colors disabled:opacity-50 ${
                                        submitState === "success"
                                          ? "border-emerald-400 bg-emerald-50 text-emerald-800"
                                          : submitState === "error"
                                            ? "border-red-300 bg-red-50 text-red-800"
                                            : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100"
                                      }`}
                                    >
                                      {submitState === "loading"
                                        ? "Submitting…"
                                        : submitState === "success"
                                          ? "Submitted"
                                          : submitState === "error"
                                            ? "Retry staging"
                                            : "Submit to staging"}
                                    </button>
                                  </div>
                                  {submitState === "success" && submitResult && (
                                    <p className="text-[11px] text-emerald-800 font-mono">
                                      session: {submitResult.sessionId} | msg: {submitResult.messageId}
                                    </p>
                                  )}
                                  {submitState === "error" && submitResult?.error && (
                                    <p className="text-[11px] text-red-700 font-mono break-all">{submitResult.error}</p>
                                  )}
                                  {isExpanded && (
                                    <video
                                      src={url}
                                      controls
                                      className="rounded border border-zinc-200 max-w-xs w-full"
                                      style={{ maxHeight: 240 }}
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
