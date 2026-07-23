"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const VISAFLOW_JWT_UPDATED_EVENT = "visaflow-jwt-updated";

/** Treat JWT as expired this many ms before `exp` (clock skew). */
const JWT_EXP_SKEW_MS = 60_000;

const KEYS = {
  bearerJwt: "ui-test-visaflow-dashboard-bearer-jwt",
  clerkSessionId: "ui-test-visaflow-clerk-refresh-session-id",
  clerkCookieJar: "ui-test-visaflow-clerk-cookie-jar",
  otpSia: "ui-test-clerk-sign-in-attempt-id",
} as const;

function primaryStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function fallbackStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function migrateSessionToLocal(): void {
  const local = primaryStore();
  const session = fallbackStore();
  if (!local || !session) return;
  for (const k of Object.values(KEYS)) {
    const fromSession = session.getItem(k);
    if (fromSession && !local.getItem(k)) {
      local.setItem(k, fromSession);
    }
  }
}

function readKey(key: string): string {
  migrateSessionToLocal();
  const local = primaryStore();
  const session = fallbackStore();
  return (local?.getItem(key) ?? session?.getItem(key) ?? "").trim();
}

function writeKey(key: string, value: string): void {
  const local = primaryStore();
  const session = fallbackStore();
  try {
    local?.setItem(key, value);
    session?.setItem(key, value);
  } catch {
    /* private mode */
  }
}

function removeKey(key: string): void {
  try {
    primaryStore()?.removeItem(key);
    fallbackStore()?.removeItem(key);
  } catch {
    /* */
  }
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractSidFromCookieJar(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.toLowerCase().startsWith("__client=")) continue;
    const val = trimmed.slice("__client=".length).trim();
    if (!val || val === "deleted") continue;
    const payload = decodeJwtPayload(val);
    const sid = payload?.sid;
    if (typeof sid === "string" && sid.startsWith("sess_")) return sid;
  }
  return null;
}

/** True if any dashboard auth material is present (even if access JWT is expired). */
export function hasStoredDashboardAuth(): boolean {
  const jwt = getBearerJwt();
  if (jwt.split(".").length >= 2) return true;
  if (getClerkSessionId().startsWith("sess_")) return true;
  return getClerkCookieJar().length > 0;
}

/** Clerk refresh session: `sess_` + cookie jar (can mint new access JWTs). */
export function hasClerkRefreshSession(): boolean {
  const jar = getClerkCookieJar();
  if (!jar) return false;
  const sid = getClerkSessionId();
  if (sid.startsWith("sess_")) return true;
  return Boolean(extractSidFromCookieJar(jar));
}

export function getBearerJwt(): string {
  return readKey(KEYS.bearerJwt);
}

export function setBearerJwt(jwt: string): void {
  writeKey(KEYS.bearerJwt, jwt);
}

export function getClerkSessionId(): string {
  return readKey(KEYS.clerkSessionId);
}

export function setClerkSessionId(sessionId: string): void {
  writeKey(KEYS.clerkSessionId, sessionId);
}

export function getClerkCookieJar(): string {
  return readKey(KEYS.clerkCookieJar);
}

export function setClerkCookieJar(cookieJar: string): void {
  writeKey(KEYS.clerkCookieJar, cookieJar);
}

export function getOtpSignInAttemptId(): string {
  return readKey(KEYS.otpSia);
}

export function setOtpSignInAttemptId(signInAttemptId: string): void {
  writeKey(KEYS.otpSia, signInAttemptId);
}

/** Access JWT present and not past `exp` (with skew). */
export function isAccessJwtFresh(): boolean {
  const jwt = getBearerJwt();
  if (jwt.split(".").length < 2) return false;
  const payload = decodeJwtPayload(jwt);
  if (!payload) return false;
  const exp = payload.exp;
  if (typeof exp !== "number") return true;
  return Date.now() < exp * 1000 - JWT_EXP_SKEW_MS;
}

/**
 * Signed in for UI: fresh access JWT, or Clerk refresh session still usable.
 * Access JWT may be stale — callers should `ensureFreshBearerJwt()` before API use.
 */
export function isDashboardAuthenticated(): boolean {
  if (isAccessJwtFresh()) return true;
  return hasClerkRefreshSession();
}

export function persistAfterVerify(payload: {
  jwt: string;
  sessionId?: string | null;
  cookieJar?: string | null;
}): void {
  const jwt = payload.jwt.trim();
  if (jwt) setBearerJwt(jwt);
  const sid = payload.sessionId?.trim() ?? "";
  if (sid.startsWith("sess_")) setClerkSessionId(sid);
  const jar = payload.cookieJar?.trim() ?? "";
  if (jar) setClerkCookieJar(jar);
  notifyJwtUpdated();
}

export function applyRefreshedBearerJwt(jwt: string | undefined | null): void {
  const next = jwt?.trim() ?? "";
  if (next && next.split(".").length >= 2) {
    setBearerJwt(next);
    notifyJwtUpdated();
  }
}

export function buildDashboardAuthBody(): {
  bearerJwt: string;
  clerkSessionId?: string;
  clerkCookie?: string;
} {
  const bearerJwt = getBearerJwt();
  const sid = getClerkSessionId();
  const jar = getClerkCookieJar();
  const sidFromJar = jar ? extractSidFromCookieJar(jar) : null;
  const sessionId = sid.startsWith("sess_") ? sid : sidFromJar ?? "";
  return {
    bearerJwt,
    ...(sessionId.startsWith("sess_") ? { clerkSessionId: sessionId } : {}),
    ...(jar ? { clerkCookie: jar } : {}),
  };
}

/**
 * Ensure a usable access JWT: return cached if fresh, else mint via Clerk
 * `/sessions/{sess_}/tokens` using stored refresh session + cookie jar.
 */
export async function ensureFreshBearerJwt(): Promise<string | null> {
  if (isAccessJwtFresh()) return getBearerJwt();
  if (!hasClerkRefreshSession()) return null;

  const { clerkSessionId, clerkCookie } = buildDashboardAuthBody();
  if (!clerkCookie || !clerkSessionId?.startsWith("sess_")) return null;

  try {
    const res = await fetch("/api/clerk-session-refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clerkSessionId, clerkCookie }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      jwt?: string;
      sessionId?: string;
      cookieJar?: string;
      error?: string;
    };
    if (!res.ok) return null;
    const jwt = typeof json.jwt === "string" ? json.jwt.trim() : "";
    if (!jwt || jwt.split(".").length < 2) return null;
    setBearerJwt(jwt);
    if (typeof json.sessionId === "string" && json.sessionId.startsWith("sess_")) {
      setClerkSessionId(json.sessionId);
    }
    if (typeof json.cookieJar === "string" && json.cookieJar.trim()) {
      setClerkCookieJar(json.cookieJar.trim());
    }
    notifyJwtUpdated();
    return jwt;
  } catch {
    return null;
  }
}

/** Wipe access JWT + Clerk refresh session before starting a fresh OTP. */
export function clearDashboardSessionForRelogin(): void {
  removeKey(KEYS.bearerJwt);
  removeKey(KEYS.clerkSessionId);
  removeKey(KEYS.clerkCookieJar);
  removeKey(KEYS.otpSia);
  notifyJwtUpdated();
}

export function clearDashboardAuth(): void {
  for (const k of Object.values(KEYS)) {
    removeKey(k);
  }
  notifyJwtUpdated();
}

export function notifyJwtUpdated(): void {
  try {
    window.dispatchEvent(new Event(VISAFLOW_JWT_UPDATED_EVENT));
  } catch {
    /* */
  }
}

export function useVisaflowDashboardAuth() {
  const [authenticated, setAuthenticated] = useState(false);
  const [hasStoredAuth, setHasStoredAuth] = useState(false);
  const [hasRefreshSession, setHasRefreshSession] = useState(false);
  const [accessJwtFresh, setAccessJwtFresh] = useState(false);
  const [refreshingJwt, setRefreshingJwt] = useState(false);
  const refreshInFlight = useRef<Promise<string | null> | null>(null);

  const sync = useCallback(() => {
    setAuthenticated(isDashboardAuthenticated());
    setHasStoredAuth(hasStoredDashboardAuth());
    setHasRefreshSession(hasClerkRefreshSession());
    setAccessJwtFresh(isAccessJwtFresh());
  }, []);

  const refreshAccessJwtIfNeeded = useCallback(async () => {
    if (isAccessJwtFresh()) {
      sync();
      return getBearerJwt();
    }
    if (!hasClerkRefreshSession()) {
      sync();
      return null;
    }
    if (refreshInFlight.current) return refreshInFlight.current;
    setRefreshingJwt(true);
    const p = ensureFreshBearerJwt().finally(() => {
      refreshInFlight.current = null;
      setRefreshingJwt(false);
      sync();
    });
    refreshInFlight.current = p;
    return p;
  }, [sync]);

  useEffect(() => {
    sync();
    void refreshAccessJwtIfNeeded();
    const onUpdate = () => sync();
    const onFocus = () => {
      sync();
      void refreshAccessJwtIfNeeded();
    };
    window.addEventListener(VISAFLOW_JWT_UPDATED_EVENT, onUpdate);
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onUpdate);
    return () => {
      window.removeEventListener(VISAFLOW_JWT_UPDATED_EVENT, onUpdate);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onUpdate);
    };
  }, [sync, refreshAccessJwtIfNeeded]);

  return {
    authenticated,
    hasStoredAuth,
    hasRefreshSession,
    accessJwtFresh,
    refreshingJwt,
    refresh: sync,
    refreshAccessJwtIfNeeded,
    clearAuth: clearDashboardAuth,
  };
}
