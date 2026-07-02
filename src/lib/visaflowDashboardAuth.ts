"use client";

import { useCallback, useEffect, useState } from "react";

export const VISAFLOW_JWT_UPDATED_EVENT = "visaflow-jwt-updated";

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

export function isDashboardAuthenticated(): boolean {
  return getBearerJwt().split(".").length >= 2;
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
  return {
    bearerJwt,
    ...(sid.startsWith("sess_") ? { clerkSessionId: sid } : {}),
    ...(jar ? { clerkCookie: jar } : {}),
  };
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

  const refresh = useCallback(() => {
    setAuthenticated(isDashboardAuthenticated());
  }, []);

  useEffect(() => {
    refresh();
    const onUpdate = () => refresh();
    window.addEventListener(VISAFLOW_JWT_UPDATED_EVENT, onUpdate);
    window.addEventListener("focus", onUpdate);
    window.addEventListener("storage", onUpdate);
    return () => {
      window.removeEventListener(VISAFLOW_JWT_UPDATED_EVENT, onUpdate);
      window.removeEventListener("focus", onUpdate);
      window.removeEventListener("storage", onUpdate);
    };
  }, [refresh]);

  return { authenticated, refresh, clearAuth: clearDashboardAuth };
}
