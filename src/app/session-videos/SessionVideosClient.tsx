"use client";

import { useEffect, useState } from "react";

const SS_CLERK_SESSION = "ui-test-visaflow-clerk-session";
const SS_CLERK_COOKIE = "ui-test-visaflow-clerk-cookie";
const SS_ORG_ID = "ui-test-visaflow-org-id";
const SS_BEARER_JWT = "ui-test-visaflow-dashboard-bearer-jwt";
/** Clerk `sess_…` from OTP verify — used with cookie jar to refresh JWT at `/sessions/{id}/tokens` when `/clients` returns 401. */
const SS_CLERK_REFRESH_SESSION_ID = "ui-test-visaflow-clerk-refresh-session-id";
const SS_OTP_COOKIE_JAR = "ui-test-clerk-otp-cookie-jar";
const SS_OTP_SIA = "ui-test-clerk-sign-in-attempt-id";

type SolveKindUi = "drop" | "verification";
type DeploymentEnvUi = "prod" | "staging";

type VideoRow = {
  email: string;
  taskId: string;
  videoLinks: string[];
  screenRecordingUrls?: string[];
  passportNumber: string | null;
};
type NotAcceptedRow = VideoRow & { failureReason: string };

type ApiResponse = {
  from: number;
  to: number;
  solveKind?: SolveKindUi;
  sessionVideoApprovedRows?: VideoRow[];
  sessionVideoNotAcceptedRows?: NotAcceptedRow[];
  error?: string;
};

type DashboardPassportEntry = {
  applicantId: string | null;
  applicant?: { firstName?: string; lastName?: string; status?: string };
  passportImages: Array<{ id: string; url: string }>;
  error?: string;
};

type DashboardPassportApi = {
  error?: string;
  byPassport?: Record<string, DashboardPassportEntry>;
  refreshedBearerJwt?: string;
};

function PassportDashboardCell({
  passportNumber,
  entry,
}: {
  passportNumber: string | null;
  entry?: DashboardPassportEntry;
}) {
  if (!passportNumber?.trim()) return <span className="text-zinc-400">—</span>;
  if (!entry) return <span className="text-zinc-400">—</span>;
  if (entry.error) {
    return <span className="text-red-600 break-words max-w-xs inline-block text-[10px]">{entry.error}</span>;
  }
  if (!entry.passportImages.length) {
    return <span className="text-zinc-500 text-[10px]">No passport images</span>;
  }
  const im = entry.passportImages[0];
  const name =
    entry.applicant &&
    [entry.applicant.firstName, entry.applicant.lastName].filter(Boolean).join(" ").trim();
  return (
    <div className="space-y-1 max-w-[200px] overflow-hidden">
      {name ? (
        <p className="text-[10px] text-zinc-600 font-medium break-words">
          {name}
          {entry.applicant?.status ? (
            <span className="text-zinc-400 font-normal"> · {entry.applicant.status}</span>
          ) : null}
        </p>
      ) : null}
      <div className="max-w-full">
        <a href={im.url} target="_blank" rel="noreferrer" className="inline-block max-w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={im.url}
            alt="Passport crop from dashboard"
            className="h-20 w-full max-w-[140px] object-cover rounded border border-zinc-200 bg-zinc-50"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        </a>
      </div>
    </div>
  );
}

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

export default function SessionVideosClient() {
  const now = Date.now();
  const defaultFrom = new Date(now - INTERVAL_MS["24h"]);
  const defaultTo = new Date(now);
  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(defaultFrom));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(defaultTo));
  const [target, setTarget] = useState("vfs-global-bot");
  const [deploymentEnv, setDeploymentEnv] = useState<DeploymentEnvUi>("prod");
  const [solveKind, setSolveKind] = useState<SolveKindUi>("drop");
  const [streamKeySuffix, setStreamKeySuffix] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [runKey, setRunKey] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [dashLoading, setDashLoading] = useState(false);
  const [dashError, setDashError] = useState<string | null>(null);
  const [dashByPassport, setDashByPassport] = useState<Record<string, DashboardPassportEntry>>({});
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
    } catch {
      /* private mode */
    }
  }, []);

  function applyPreset(interval: string) {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["24h"];
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    setFromStr(toDatetimeLocal(from));
    setToStr(toDatetimeLocal(to));
  }

  async function handleLoad() {
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
          deploymentEnv,
          includeVideoSessionRows: true,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as ApiResponse & { error?: string };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        setLoading(false);
        return;
      }
      setData(json);
      setDashByPassport({});
      setDashError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  async function loadDashboardPassportImages() {
    if (!data) return;
    const approvedRows = data.sessionVideoApprovedRows ?? [];
    const notRows = data.sessionVideoNotAcceptedRows ?? [];
    const nums = new Set<string>();
    for (const r of approvedRows) {
      if (r.passportNumber?.trim()) nums.add(r.passportNumber.trim());
    }
    for (const r of notRows) {
      if (r.passportNumber?.trim()) nums.add(r.passportNumber.trim());
    }
    if (nums.size === 0) {
      setDashError("No passport numbers in the loaded tables.");
      return;
    }
    setDashError(null);
    setDashLoading(true);
    try {
      let bearerFromStorage = "";
      try {
        bearerFromStorage = sessionStorage.getItem(SS_BEARER_JWT)?.trim() ?? "";
      } catch {
        /* */
      }
      const useBearer = Boolean(bearerFromStorage && bearerFromStorage.split(".").length >= 2);
      let refreshSid = "";
      let refreshJar = "";
      try {
        refreshSid = sessionStorage.getItem(SS_CLERK_REFRESH_SESSION_ID)?.trim() ?? "";
        refreshJar = sessionStorage.getItem(SS_OTP_COOKIE_JAR)?.trim() ?? "";
      } catch {
        /* */
      }
      const res = await fetch("/api/dashboard-passport-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          passportNumbers: [...nums],
          ...(useBearer
            ? {
                bearerJwt: bearerFromStorage,
                ...(refreshSid.startsWith("sess_") ? { clerkSessionId: refreshSid } : {}),
                ...(refreshJar ? { clerkCookie: refreshJar } : {}),
              }
            : {
                ...(clerkSessionId.trim() ? { clerkSessionId: clerkSessionId.trim() } : {}),
                ...(clerkCookie.trim() ? { clerkCookie: clerkCookie.trim() } : {}),
                ...(organizationId.trim() ? { organizationId: organizationId.trim() } : {}),
              }),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as DashboardPassportApi;
      if (!res.ok) {
        setDashError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      try {
        const next = typeof json.refreshedBearerJwt === "string" ? json.refreshedBearerJwt.trim() : "";
        if (next && next.split(".").length >= 2) {
          sessionStorage.setItem(SS_BEARER_JWT, next);
        }
      } catch {
        /* */
      }
      setDashByPassport(json.byPassport ?? {});
      try {
        if (clerkSessionId.trim()) sessionStorage.setItem(SS_CLERK_SESSION, clerkSessionId.trim());
        if (clerkCookie.trim()) sessionStorage.setItem(SS_CLERK_COOKIE, clerkCookie.trim());
        sessionStorage.setItem(SS_ORG_ID, organizationId.trim());
      } catch {
        /* */
      }
    } catch (e: unknown) {
      setDashError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setDashLoading(false);
    }
  }

  function dashEntryFor(passportNumber: string | null | undefined): DashboardPassportEntry | undefined {
    const k = passportNumber?.trim();
    if (!k) return undefined;
    return dashByPassport[k];
  }

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
      const data = parseOtpJsonResponse(text);
      if (!res.ok) {
        setOtpError(formatOtpFailure(res, data));
        return;
      }
      const signInAttemptId = typeof data.signInAttemptId === "string" ? data.signInAttemptId : "";
      const cookieJar = typeof data.cookieJar === "string" ? data.cookieJar : "";
      if (!signInAttemptId || !cookieJar) {
        setOtpError(formatOtpFailure(res, { ...data, error: "Missing signInAttemptId or cookieJar in success body" }));
        return;
      }
      const warn = typeof data.warning === "string" ? data.warning.trim() : "";
      const prepared = data.prepareFirstFactorOk === true;
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
      const data = parseOtpJsonResponse(text);
      if (!res.ok) {
        setOtpError(formatOtpFailure(res, data));
        return;
      }
      const jwt = typeof data.jwt === "string" ? data.jwt : "";
      if (!jwt) {
        setOtpError(formatOtpFailure(res, { ...data, error: "No jwt in verify response body" }));
        return;
      }
      try {
        sessionStorage.setItem(SS_BEARER_JWT, jwt);
        const nextJar = typeof data.cookieJar === "string" ? data.cookieJar : "";
        if (nextJar) {
          sessionStorage.setItem(SS_OTP_COOKIE_JAR, nextJar);
          setOtpCookieJar(nextJar);
        }
        const sid = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
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

  /** Discriminator must be unique per Run control (row index + video index + URL). */
  function runRowKey(scope: "ap" | "na", rowDiscriminator: string, videoUrl: string | null): string {
    return `${scope}:${rowDiscriminator}|${videoUrl ?? ""}|${streamKeySuffix.trim()}`;
  }

  async function runTestSession(videoUrl: string, scope: "ap" | "na", rowDiscriminator: string) {
    const suffix = streamKeySuffix.trim();
    if (!suffix) {
      setRunError("Set stream key ID (last segment) first.");
      return;
    }
    if (!videoUrl) return;
    setRunError(null);
    const key = runRowKey(scope, rowDiscriminator, videoUrl);
    setRunKey(key);
    try {
      const res = await fetch("/api/approved-videos/run-one", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl, streamKeySuffix: suffix }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; success?: boolean; streamKey?: string };
      if (!res.ok) {
        setRunError(json.error ?? `HTTP ${res.status}`);
        return;
      }
    } catch (e: unknown) {
      setRunError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setRunKey(null);
    }
  }

  const approved = data?.sessionVideoApprovedRows ?? [];
  const notAccepted = data?.sessionVideoNotAcceptedRows ?? [];

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Session video queues</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Cohort from Grafana <code className="text-xs">In-house identity</code> outcomes and{" "}
          <code className="text-xs">In-house solver</code> lines (via Approved videos API). Each table row is one
          solve session (<code className="text-xs">TaskId</code> from{" "}
          <code className="text-xs">Solving in-house identity verification</code>), not just email — same email reused
          across applicants stays split.           <code className="text-xs">VideoLink=</code> URLs come only from the{" "}
          <code className="text-xs">In-house solver</code> Loki stream for that email in the solve window (same source
          as approved-videos); <code className="text-xs">Attempt n/m</code> outcome lines are not used for URLs. Azure liveness <code className="text-xs">[RECORDING] Uploaded:</code> MP4s are matched to the same
          session by <code className="text-xs">[JOB_ID:…]</code> / URL vs VFS <code className="text-xs">TaskId</code>. Use{" "}
          <span className="font-medium">Run 1/n</span> per video to enqueue on
          Redis stream <code className="text-xs">azure:identity-verification:stream:</code>
          <span className="font-mono text-xs">…</span> using the ID field below (same as{" "}
          <code className="text-xs">test-session.js</code>).
        </p>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 space-y-4">
        <div>
          <span className="block text-sm font-medium text-zinc-700 mb-2">Environment</span>
          <div className="flex gap-2 flex-wrap" role="group" aria-label="Deployment environment">
            {(
              [
                { id: "prod" as const, label: "Production" },
                { id: "staging" as const, label: "Staging" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setDeploymentEnv(opt.id)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  deploymentEnv === opt.id
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-300 text-zinc-700 hover:bg-zinc-50"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div>
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
        <div className="lg:col-span-2">
          <label className="block text-sm font-medium text-zinc-700 mb-1">
            Stream key ID <span className="text-zinc-500 font-normal">(last path segment)</span>
          </label>
          <input
            type="text"
            value={streamKeySuffix}
            onChange={(e) => setStreamKeySuffix(e.target.value)}
            placeholder="e.g. staging"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white font-mono placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
          <p className="text-xs text-zinc-500 mt-1">
            Full key: <code className="text-[11px]">azure:identity-verification:stream:</code>
            <span className="font-mono text-[11px]">{streamKeySuffix.trim() || "…"}</span>
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-emerald-200 bg-emerald-50/80 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-zinc-800">Visaflow sign-in (email OTP)</p>
          {dashboardJwtSaved ? (
            <span className="text-xs font-medium text-emerald-800">Dashboard JWT saved</span>
          ) : (
            <span className="text-xs text-zinc-500">No JWT yet — complete OTP below (only email + code)</span>
          )}
        </div>
        <p className="text-xs text-zinc-600">
          Server uses your Clerk bootstrap cookie from repo defaults (override with{" "}
          <code className="text-[10px]">VISAFLOW_CLERK_BOOTSTRAP_COOKIE</code> in <code className="text-[10px]">.env.local</code>{" "}
          when Cloudflare / <code className="text-[10px]">__client</code> expires).
        </p>
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

      <details className="rounded-lg border border-amber-200 bg-amber-50/80 px-4 py-3 space-y-3 group">
        <summary className="cursor-pointer text-sm font-medium text-zinc-800 list-none flex items-center gap-2 [&::-webkit-details-marker]:hidden">
          <span className="text-zinc-500 group-open:hidden">▶</span>
          <span className="hidden group-open:inline">▼</span>
          Advanced: manual Clerk session (only if OTP / JWT is not used)
        </summary>
        <div className="pt-2 space-y-3">
        {dashboardJwtSaved ? (
          <p className="text-xs text-emerald-800">
            A JWT from email OTP is saved — <span className="font-medium">Load passport images</span> uses it and
            you can ignore this section unless the JWT expires (then clear JWT or re-verify).
          </p>
        ) : null}
        <p className="text-xs text-zinc-600 space-y-1">
          <span className="block">
            <span className="font-medium text-zinc-800">Session id:</span> DevTools → Application → Cookies →{" "}
            <code className="text-[10px]">https://visaflow.devflexi.com</code> → copy the value of the{" "}
            <code className="text-[10px]">clerk_active_context</code> cookie (starts with{" "}
            <code className="text-[10px]">sess_</code>), or take <code className="text-[10px]">sess_…</code> from the
            tokens URL in Network.
          </span>
          <span className="block">
            <span className="font-medium text-zinc-800">Cookie string:</span> same Application → Cookies table:
            build <code className="text-[10px]">name=value</code> pairs joined with{" "}
            <code className="text-[10px]">; </code> — include HttpOnly ones such as{" "}
            <code className="text-[10px]">__client</code>, <code className="text-[10px]">__session</code>,{" "}
            <code className="text-[10px]">__client_uat</code>, <code className="text-[10px]">__cfuvid</code>, etc.
            Easiest: Network → any request to <code className="text-[10px]">clerk.visaflow.devflexi.com</code> →
            Headers → copy the full <code className="text-[10px]">cookie:</code> line (without the{" "}
            <code className="text-[10px]">cookie:</code> prefix).
          </span>
          <span className="block text-zinc-500">
            Saved in this browser (sessionStorage) after a successful image load. Server{" "}
            <code className="text-[10px]">VISAFLOW_CLERK_*</code> env still overrides when these fields are empty.
          </span>
        </p>

        <details className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-700">
          <summary className="cursor-pointer font-medium text-zinc-800 select-none">
            Example shape (fake values — replace with yours)
          </summary>
          <div className="mt-2 space-y-2 font-mono text-[11px] leading-relaxed">
            <div>
              <span className="text-zinc-500 font-sans">Session id field — one line, no spaces:</span>
              <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-zinc-100 px-2 py-1.5 text-zinc-900">
                sess_3CFtQbddfNqLEUMuMtJtAbCdEfGhIj
              </pre>
            </div>
            <div>
              <span className="text-zinc-500 font-sans">
                Cookie field — one long line, semicolon + space between cookies, no{" "}
                <code className="text-[10px]">Cookie:</code> prefix:
              </span>
              <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-zinc-100 px-2 py-1.5 text-zinc-900">
                {`__cfuvid=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-1234567890-0.0.1.1-604800000; __client=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJ…your_real_long_jwt…signature; __client_uat=1775993130; __session=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJ…another_long_jwt…signature; clerk_active_context=sess_3CFtQbddfNqLEUMuMtJtAbCdEfGhIj`}
              </pre>
            </div>
            <p className="text-zinc-500 font-sans">
              Organization id: usually leave empty (same as curl <code className="text-[10px]">organization_id=</code>{" "}
              with nothing after <code className="text-[10px]">=</code>). If your tenant needs it, paste the org id
              string only.
            </p>
            <p className="text-zinc-500 font-sans">
              If you see <code className="text-[10px]">Clerk token (401)</code>: the <code className="text-[10px]">sess_</code>{" "}
              id must belong to the same browser session as <code className="text-[10px]">__client</code> — copy both
              from one Network request to <code className="text-[10px]">…/sessions/sess_…/tokens</code>, or refresh
              visaflow and paste fresh cookies (Cloudflare <code className="text-[10px]">__cf_bm</code> expires).
            </p>
          </div>
        </details>

        <div>
          <label className="block text-xs font-medium text-zinc-700 mb-1">
            Clerk session id <span className="text-zinc-500 font-normal">(e.g. from clerk_active_context)</span>
          </label>
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
          <label className="block text-xs font-medium text-zinc-700 mb-1">
            Cookie header value <span className="text-zinc-500 font-normal">(paste only the value, not Cookie:)</span>
          </label>
          <textarea
            value={clerkCookie}
            onChange={(e) => setClerkCookie(e.target.value)}
            placeholder="__client=…; __session=…; __client_uat=…; __cfuvid=…"
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
            placeholder="Leave empty if curl used organization_id="
            autoComplete="off"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900"
          />
        </div>
        </div>
      </details>

      <div className="flex flex-wrap gap-2 items-center">
        <button
          type="button"
          onClick={handleLoad}
          disabled={loading}
          className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load tables"}
        </button>
        <button
          type="button"
          onClick={loadDashboardPassportImages}
          disabled={loading || !data || dashLoading}
          className="inline-flex items-center rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
        >
          {dashLoading ? "Loading dashboard images…" : "Load passport images (dashboard)"}
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
      )}
      {runError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{runError}</p>
      )}
      {dashError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{dashError}</p>
      )}

      {data && (
        <div className="space-y-8">
          <section>
            <h2 className="text-sm font-semibold text-zinc-900 mb-2">
              Approved videos <span className="text-zinc-500 font-normal">({approved.length})</span>
            </h2>
            <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
              <table className="min-w-full text-xs">
                <thead className="bg-zinc-100 text-zinc-800">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold w-44">Session</th>
                    <th className="px-3 py-2 text-left font-semibold">Videos (solver attempts)</th>
                    <th className="px-3 py-2 text-left font-semibold">Screen recordings (Azure)</th>
                    <th className="px-3 py-2 text-left font-semibold">Passport</th>
                    <th className="px-3 py-2 text-left font-semibold min-w-[200px]">Dashboard passport images</th>
                    <th className="px-3 py-2 text-left font-semibold w-36">Run test-session</th>
                  </tr>
                </thead>
                <tbody>
                  {approved.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-4 text-zinc-500">
                        No rows
                      </td>
                    </tr>
                  ) : (
                    approved.map((row, idx) => (
                      <tr key={`${row.taskId}|${idx}`} className="border-t border-zinc-100 align-top">
                        <td className="px-3 py-2 align-top text-[11px]">
                          <div className="font-mono text-zinc-900 break-all">{row.email}</div>
                          <div className="mt-1 text-zinc-500 break-all" title={row.taskId}>
                            {row.taskId}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {row.videoLinks.length === 0 ? (
                            <span className="text-zinc-400">—</span>
                          ) : (
                            <ol className="list-decimal pl-4 space-y-2">
                              {row.videoLinks.map((url, vidx) => (
                                <li key={`${url}|${vidx}`} className="break-all font-mono">
                                  <a
                                    href={url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-blue-700 underline"
                                  >
                                    {url}
                                  </a>
                                </li>
                              ))}
                            </ol>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">
                          {(row.screenRecordingUrls ?? []).length === 0 ? (
                            <span className="text-zinc-400">—</span>
                          ) : (
                            <ol className="list-decimal pl-4 space-y-2">
                              {(row.screenRecordingUrls ?? []).map((url, sidx) => (
                                <li key={`${url}|${sidx}`} className="break-all font-mono text-[11px]">
                                  <a
                                    href={url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-violet-700 underline"
                                  >
                                    {url}
                                  </a>
                                </li>
                              ))}
                            </ol>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-zinc-900">{row.passportNumber ?? "—"}</td>
                        <td className="px-3 py-2 align-top max-w-[220px] overflow-hidden">
                          <PassportDashboardCell
                            passportNumber={row.passportNumber}
                            entry={dashEntryFor(row.passportNumber)}
                          />
                        </td>
                        <td className="px-3 py-2 relative z-10 bg-white">
                          {row.videoLinks.length === 0 ? (
                            <span className="text-zinc-400 text-[11px]">No solver videos</span>
                          ) : (
                            <div className="flex flex-col gap-1.5">
                              {row.videoLinks.map((url, vidx) => (
                                <button
                                  key={`run-ap-${url}|${vidx}`}
                                  type="button"
                                  disabled={
                                    !streamKeySuffix.trim() ||
                                    runKey === runRowKey("ap", `${row.taskId}|${vidx}`, url)
                                  }
                                  onClick={() => runTestSession(url, "ap", `${row.taskId}|${vidx}`)}
                                  className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-40 whitespace-nowrap"
                                >
                                  {runKey === runRowKey("ap", `${row.taskId}|${vidx}`, url)
                                    ? "Running…"
                                    : `Run ${vidx + 1}/${row.videoLinks.length}`}
                                </button>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold text-zinc-900 mb-2">
              Not accepted <span className="text-zinc-500 font-normal">({notAccepted.length})</span>
            </h2>
            <p className="text-xs text-zinc-500 mb-2">
              Identity outcome: <code className="text-[10px]">In-house identity verification failed</code> (not approved
              after in-house solves) or legacy <code className="text-[10px]">status not approved</code> lines. Videos are
              same per-session video list as the approved table (all attempts in the window that carry{" "}
              <code className="text-[10px]">VideoLink=</code>).
            </p>
            <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
              <table className="min-w-full text-xs">
                <thead className="bg-zinc-100 text-zinc-800">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold w-44">Session</th>
                    <th className="px-3 py-2 text-left font-semibold">Videos (solver attempts)</th>
                    <th className="px-3 py-2 text-left font-semibold">Screen recordings (Azure)</th>
                    <th className="px-3 py-2 text-left font-semibold">Passport</th>
                    <th className="px-3 py-2 text-left font-semibold min-w-[200px]">Dashboard passport images</th>
                    <th className="px-3 py-2 text-left font-semibold">Reason</th>
                    <th className="px-3 py-2 text-left font-semibold w-36">Run test-session</th>
                  </tr>
                </thead>
                <tbody>
                  {notAccepted.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-4 text-zinc-500">
                        No rows
                      </td>
                    </tr>
                  ) : (
                    notAccepted.map((row, idx) => (
                      <tr key={`${row.taskId}|${idx}`} className="border-t border-zinc-100 align-top">
                        <td className="px-3 py-2 align-top text-[11px]">
                          <div className="font-mono text-zinc-900 break-all">{row.email}</div>
                          <div className="mt-1 text-zinc-500 break-all" title={row.taskId}>
                            {row.taskId}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {row.videoLinks.length === 0 ? (
                            <span className="text-zinc-400">—</span>
                          ) : (
                            <ol className="list-decimal pl-4 space-y-2">
                              {row.videoLinks.map((url, vidx) => (
                                <li key={`${url}|${vidx}`} className="break-all font-mono">
                                  <a
                                    href={url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-blue-700 underline"
                                  >
                                    {url}
                                  </a>
                                </li>
                              ))}
                            </ol>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">
                          {(row.screenRecordingUrls ?? []).length === 0 ? (
                            <span className="text-zinc-400">—</span>
                          ) : (
                            <ol className="list-decimal pl-4 space-y-2">
                              {(row.screenRecordingUrls ?? []).map((url, sidx) => (
                                <li key={`${url}|${sidx}`} className="break-all font-mono text-[11px]">
                                  <a
                                    href={url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-violet-700 underline"
                                  >
                                    {url}
                                  </a>
                                </li>
                              ))}
                            </ol>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-zinc-900">{row.passportNumber ?? "—"}</td>
                        <td className="px-3 py-2 align-top max-w-[220px] overflow-hidden">
                          <PassportDashboardCell
                            passportNumber={row.passportNumber}
                            entry={dashEntryFor(row.passportNumber)}
                          />
                        </td>
                        <td className="px-3 py-2 font-mono text-zinc-700 break-all max-w-md">{row.failureReason}</td>
                        <td className="px-3 py-2 relative z-10 bg-white">
                          {row.videoLinks.length === 0 ? (
                            <span className="text-zinc-400 text-[11px]">No solver videos</span>
                          ) : (
                            <div className="flex flex-col gap-1.5">
                              {row.videoLinks.map((url, vidx) => (
                                <button
                                  key={`run-na-${url}|${vidx}`}
                                  type="button"
                                  disabled={
                                    !streamKeySuffix.trim() ||
                                    runKey === runRowKey("na", `${row.taskId}|${vidx}`, url)
                                  }
                                  onClick={() => runTestSession(url, "na", `${row.taskId}|${vidx}`)}
                                  className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-40 whitespace-nowrap"
                                >
                                  {runKey === runRowKey("na", `${row.taskId}|${vidx}`, url)
                                    ? "Running…"
                                    : `Run ${vidx + 1}/${row.videoLinks.length}`}
                                </button>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
