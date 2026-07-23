"use client";

import { useEffect, useState } from "react";
import {
  clearDashboardSessionForRelogin,
  getClerkCookieJar,
  getOtpSignInAttemptId,
  isDashboardAuthenticated,
  persistAfterVerify,
  setClerkCookieJar,
  setOtpSignInAttemptId,
  useVisaflowDashboardAuth,
} from "@/lib/visaflowDashboardAuth";

type Props = {
  title?: string;
  hint?: string;
  /** @deprecated Sign out is always available when signed in / stored auth exists. */
  showClearButton?: boolean;
  onAuthenticated?: () => void;
};

function parseOtpJsonResponse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text.slice(0, 800) || "Empty or invalid JSON" };
  }
}

export default function VisaflowDashboardLoginPanel({
  title = "Visaflow dashboard login",
  hint = "Email OTP — saved across pages until you clear it or sign out. Access JWT refreshes via Clerk session.",
  onAuthenticated,
}: Props) {
  const {
    authenticated,
    hasStoredAuth,
    hasRefreshSession,
    accessJwtFresh,
    refreshingJwt,
    clearAuth,
  } = useVisaflowDashboardAuth();
  const [reloginOpen, setReloginOpen] = useState(false);
  const [otpEmail, setOtpEmail] = useState("");
  const [otpCookieJar, setOtpCookieJarState] = useState("");
  const [otpSignInAttemptId, setOtpSignInAttemptIdState] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);

  useEffect(() => {
    const jar = getClerkCookieJar();
    const sia = getOtpSignInAttemptId();
    if (jar) setOtpCookieJarState(jar);
    if (sia) setOtpSignInAttemptIdState(sia);
  }, []);

  useEffect(() => {
    if (authenticated) onAuthenticated?.();
  }, [authenticated, onAuthenticated]);

  async function sendClerkOtp() {
    setOtpError(null);
    const email = otpEmail.trim();
    if (!email.includes("@")) {
      setOtpError("Enter a valid email.");
      return;
    }
    // Fresh OTP replaces the persistent session once the user commits to Send code.
    if (reloginOpen || hasStoredAuth) {
      clearDashboardSessionForRelogin();
      setOtpCookieJarState("");
      setOtpSignInAttemptIdState("");
      setOtpCode("");
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
      setOtpSignInAttemptIdState(signInAttemptId);
      setOtpCookieJarState(cookieJar);
      setOtpSignInAttemptId(signInAttemptId);
      setClerkCookieJar(cookieJar);
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
      persistAfterVerify({
        jwt,
        sessionId: typeof otpData.sessionId === "string" ? otpData.sessionId : null,
        cookieJar: typeof otpData.cookieJar === "string" ? otpData.cookieJar : jar,
      });
      setOtpCode("");
      setReloginOpen(false);
    } catch (e: unknown) {
      setOtpError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setOtpLoading(false);
    }
  }

  function signOut() {
    clearAuth();
    setOtpCode("");
    setOtpCookieJarState("");
    setOtpSignInAttemptIdState("");
    setOtpError(null);
    setReloginOpen(false);
  }

  const showCompactSignedIn = authenticated && !reloginOpen;
  // Only force OTP when stored junk exists but neither fresh JWT nor Clerk refresh works.
  const needsOtpAgain = hasStoredAuth && !authenticated && !refreshingJwt;

  if (showCompactSignedIn) {
    const statusLabel = refreshingJwt
      ? "Refreshing session…"
      : accessJwtFresh
        ? "Visaflow dashboard signed in"
        : hasRefreshSession
          ? "Signed in (refresh session)"
          : "Visaflow dashboard signed in";
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/80 px-4 py-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-emerald-800">{statusLabel}</span>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setReloginOpen(true);
              setOtpError(null);
            }}
            className="rounded-lg border border-emerald-700 px-3 py-1.5 text-xs text-emerald-900 bg-white"
          >
            Re-login
          </button>
          <button
            type="button"
            onClick={signOut}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 bg-white"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/80 px-4 py-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-zinc-800">{title}</p>
        {authenticated ? (
          <span className="text-xs font-medium text-emerald-800">Signed in — re-login</span>
        ) : needsOtpAgain ? (
          <span className="text-xs font-medium text-amber-800">Session expired — sign in again</span>
        ) : (
          <span className="text-xs text-zinc-500">Required</span>
        )}
      </div>
      {hint ? <p className="text-xs text-zinc-500">{hint}</p> : null}
      {reloginOpen && authenticated ? (
        <p className="text-xs text-zinc-600">
          Current session (including refresh) stays until you click{" "}
          <span className="font-medium">Send code</span>.
        </p>
      ) : null}
      {otpError ? <pre className="text-[11px] text-red-800 whitespace-pre-wrap">{otpError}</pre> : null}
      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-zinc-700 mb-1">Email</label>
          <input
            type="email"
            value={otpEmail}
            onChange={(e) => setOtpEmail(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white"
          />
        </div>
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
          className="rounded-lg border border-emerald-700 px-3 py-2 text-sm text-emerald-900"
        >
          Verify
        </button>
        {reloginOpen && authenticated ? (
          <button
            type="button"
            onClick={() => {
              setReloginOpen(false);
              setOtpError(null);
            }}
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700"
          >
            Cancel
          </button>
        ) : null}
        {hasStoredAuth || authenticated ? (
          <button
            type="button"
            onClick={signOut}
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700"
          >
            Sign out
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** For callers that only need a boolean without rendering the panel. */
export { isDashboardAuthenticated };
