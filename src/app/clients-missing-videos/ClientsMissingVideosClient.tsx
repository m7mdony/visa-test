"use client";

import { useEffect, useState } from "react";

const SS_CLERK_SESSION = "ui-test-visaflow-clerk-session";
const SS_CLERK_COOKIE = "ui-test-visaflow-clerk-cookie";
const SS_ORG_ID = "ui-test-visaflow-org-id";
const SS_BEARER_JWT = "ui-test-visaflow-dashboard-bearer-jwt";
const SS_CLERK_REFRESH_SESSION_ID = "ui-test-visaflow-clerk-refresh-session-id";
const SS_OTP_COOKIE_JAR = "ui-test-clerk-otp-cookie-jar";
const SS_OTP_SIA = "ui-test-clerk-sign-in-attempt-id";

type MissingVideoRow = {
  clientId: string;
  applicantId: string;
  firstName: string;
  lastName: string;
  clientStatus: string;
  identityVerificationStatus: string;
  fromCountry: string;
  toCountry: string;
};

type ApiResponse = {
  totals: {
    clientsScanned: number;
    clientsMatchedCountry: number;
    applicantsChecked: number;
    applicantsIdentityCompleted: number;
    applicantsWithoutVideos: number;
  };
  rows: MissingVideoRow[];
  refreshedBearerJwt?: string;
  error?: string;
};

export default function ClientsMissingVideosClient() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);

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
      const res = await fetch("/api/clients-missing-videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          useBearer
            ? {
                bearerJwt: bearerFromStorage,
                ...(refreshSid.startsWith("sess_") ? { clerkSessionId: refreshSid } : {}),
                ...(refreshJar ? { clerkCookie: refreshJar } : {}),
              }
            : {
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

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Clients missing videos</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Finds dashboard applicants where client route is <code>AGO → PRT</code> or <code>AGO → BRA</code>, client
          status is <code>pending/processing/error</code>, and applicant identity is <code>completed</code> but liveness
          videos are missing.
        </p>
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

      <button
        type="button"
        onClick={handleLoad}
        disabled={loading}
        className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {loading ? "Scanning..." : "Scan missing videos"}
      </button>

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>}

      {data && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="text-xs text-zinc-500">Clients scanned</p>
              <p className="text-lg font-semibold">{data.totals.clientsScanned}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="text-xs text-zinc-500">Country-matched clients</p>
              <p className="text-lg font-semibold">{data.totals.clientsMatchedCountry}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="text-xs text-zinc-500">Applicants checked</p>
              <p className="text-lg font-semibold">{data.totals.applicantsChecked}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="text-xs text-zinc-500">Identity completed</p>
              <p className="text-lg font-semibold">{data.totals.applicantsIdentityCompleted}</p>
            </div>
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
              <p className="text-xs text-red-700">No videos</p>
              <p className="text-lg font-semibold text-red-900">{data.totals.applicantsWithoutVideos}</p>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
            <table className="min-w-full text-xs">
              <thead className="bg-zinc-100 text-zinc-800">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Applicant</th>
                  <th className="px-3 py-2 text-left font-semibold">Applicant ID</th>
                  <th className="px-3 py-2 text-left font-semibold">Client ID</th>
                  <th className="px-3 py-2 text-left font-semibold">Client status</th>
                  <th className="px-3 py-2 text-left font-semibold">Identity status</th>
                  <th className="px-3 py-2 text-left font-semibold">Route</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-4 text-zinc-500">
                      No matching applicants without videos.
                    </td>
                  </tr>
                ) : (
                  data.rows.map((row) => (
                    <tr key={`${row.clientId}|${row.applicantId}`} className="border-t border-zinc-100 align-top">
                      <td className="px-3 py-2 font-medium text-zinc-900">
                        {[row.firstName, row.lastName].filter(Boolean).join(" ").trim() || "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-zinc-700">{row.applicantId}</td>
                      <td className="px-3 py-2 font-mono text-zinc-700">{row.clientId}</td>
                      <td className="px-3 py-2">{row.clientStatus}</td>
                      <td className="px-3 py-2">{row.identityVerificationStatus}</td>
                      <td className="px-3 py-2 font-mono uppercase">
                        {row.fromCountry} → {row.toCountry}
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
