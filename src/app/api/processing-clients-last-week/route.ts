import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { stripCookieHeaderPrefix } from "@/lib/clerkVisaflowFapi";
import type { ProcessingClientApplicant, ProcessingClientRow } from "@/lib/processingClientsLastWeek";

const ENV_CLERK_BASE = process.env.VISAFLOW_CLERK_BASE ?? "https://clerk.visaflow.devflexi.com";
const ENV_BACKEND_URL = process.env.VISAFLOW_BACKEND_URL ?? "https://visaflow-backend.fastjourney.shop";
const ENV_APP_ORIGIN = process.env.VISAFLOW_APP_ORIGIN ?? "https://visaflow.devflexi.com";
const ENV_SESSION_ID = process.env.VISAFLOW_CLERK_SESSION_ID ?? "";
const ENV_CLERK_COOKIE = process.env.VISAFLOW_CLERK_COOKIE ?? "";
const ENV_ORGANIZATION_ID = process.env.VISAFLOW_ORGANIZATION_ID ?? "";
const ENV_CLERK_API_VERSION = process.env.VISAFLOW_CLERK_API_VERSION ?? "2025-11-10";
const ENV_CLERK_JS_VERSION = process.env.VISAFLOW_CLERK_JS_VERSION ?? "5.125.7";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const CLIENTS_FETCH_TIMEOUT_MS = 120_000;
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type FetchCtx = {
  clerkBase: string;
  backendUrl: string;
  appOrigin: string;
  sessionId: string;
  clerkCookie: string;
  organizationId: string;
  clerkApiVersion: string;
  clerkJsVersion: string;
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function parseCreatedAtMs(v: unknown): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  let s = v.trim();
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) s = s.replace(" ", "T");
  if (/\+00$/.test(s)) s = s.replace(/\+00$/, "+00:00");
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function parseCutoffDateMs(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function applicantPassportField(ap: Record<string, unknown>): string {
  for (const k of ["passportNumber", "passport", "PassportNumber", "passportNo"]) {
    const v = ap[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

function applicantDisplayName(ap: Record<string, unknown>): string {
  for (const k of ["name", "fullName", "applicantName", "displayName"]) {
    const v = ap[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const first = typeof ap.firstName === "string" ? ap.firstName.trim() : "";
  const last = typeof ap.lastName === "string" ? ap.lastName.trim() : "";
  return [first, last].filter(Boolean).join(" ");
}

function userDisplayName(c: Record<string, unknown>): string {
  const user = c.user;
  if (!user || typeof user !== "object") return "";
  const u = user as Record<string, unknown>;
  const first = typeof u.firstName === "string" ? u.firstName.trim() : "";
  const last = typeof u.lastName === "string" ? u.lastName.trim() : "";
  return [first, last].filter(Boolean).join(" ");
}

function subVisaFromClient(c: Record<string, unknown>): string {
  const direct = typeof c.subVisaCategoryName === "string" ? c.subVisaCategoryName.trim() : "";
  if (direct) return direct;
  const nested = c.subVisaCategory;
  if (nested && typeof nested === "object") {
    const name = (nested as Record<string, unknown>).name;
    return typeof name === "string" ? name.trim() : "";
  }
  return "";
}

function parseClientsToRows(json: unknown): ProcessingClientRow[] {
  const root = json as Record<string, unknown>;
  const arr = Array.isArray(root?.data) ? (root.data as unknown[]) : [];
  const out: ProcessingClientRow[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.id !== "string" || !c.id) continue;
    const createdAt = typeof c.createdAt === "string" ? c.createdAt : "";
    const createdAtMs = parseCreatedAtMs(c.createdAt);
    if (createdAtMs == null) continue;
    const applicantsRaw = Array.isArray(c.applicants) ? c.applicants : [];
    const applicants: ProcessingClientApplicant[] = [];
    for (const apRaw of applicantsRaw) {
      if (!apRaw || typeof apRaw !== "object") continue;
      const ap = apRaw as Record<string, unknown>;
      if (typeof ap.id !== "string" || !ap.id) continue;
      applicants.push({
        applicantId: ap.id,
        passportNumber: applicantPassportField(ap),
        firstName: typeof ap.firstName === "string" ? ap.firstName.trim() : "",
        lastName: typeof ap.lastName === "string" ? ap.lastName.trim() : "",
        displayName: applicantDisplayName(ap),
      });
    }
    out.push({
      clientId: c.id,
      status: typeof c.status === "string" ? c.status.toLowerCase() : "",
      createdAt,
      createdAtMs,
      updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : "",
      fromCountry: typeof c.fromCountry === "string" ? c.fromCountry.toLowerCase() : "",
      toCountry: typeof c.toCountry === "string" ? c.toCountry.toLowerCase() : "",
      visaCategoryName: typeof c.visaCategoryName === "string" ? c.visaCategoryName : "",
      subVisaCategoryName: subVisaFromClient(c),
      visaCenterName: typeof c.visaCenterName === "string" ? c.visaCenterName : "",
      notes: typeof c.notes === "string" ? c.notes : "",
      userName: userDisplayName(c),
      applicantCount: applicants.length,
      applicants,
      errorMessage: typeof c.errorMessage === "string" ? c.errorMessage : "",
      isPaused: c.isPaused === true,
    });
  }
  return out;
}

function clerkTokenUrl(ctx: FetchCtx): string {
  const q = new URLSearchParams({
    __clerk_api_version: ctx.clerkApiVersion,
    _clerk_js_version: ctx.clerkJsVersion,
  });
  return `${ctx.clerkBase.replace(/\/$/, "")}/v1/client/sessions/${ctx.sessionId}/tokens?${q.toString()}`;
}

function extractSidFromClientCookie(cookieHeader: string): string | null {
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed.toLowerCase().startsWith("__client=")) continue;
    const val = trimmed.slice("__client=".length).trim();
    if (!val || val === "deleted") continue;
    const seg = val.split(".");
    if (seg.length < 2) continue;
    try {
      let payloadB64 = seg[1].replace(/-/g, "+").replace(/_/g, "/");
      const pad = (4 - (payloadB64.length % 4)) % 4;
      payloadB64 += "=".repeat(pad);
      const json = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8")) as Record<string, unknown>;
      const sid = json.sid;
      if (typeof sid === "string" && sid.startsWith("sess_")) return sid;
    } catch {
      continue;
    }
  }
  return null;
}

function extractClerkJwtFromJson(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  for (const k of ["jwt", "token", "session_token"]) {
    const v = o[k];
    if (typeof v === "string" && v.length > 20) return v;
  }
  const data = o.data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    for (const k of ["jwt", "token", "session_token"]) {
      const v = d[k];
      if (typeof v === "string" && v.length > 20) return v;
    }
  }
  return null;
}

async function fetchClerkJwtOnce(
  ctx: FetchCtx,
  referer: string,
): Promise<{ ok: true; jwt: string } | { ok: false; error: string; status: number }> {
  const res = await fetch(clerkTokenUrl(ctx), {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded",
      cookie: ctx.clerkCookie,
      origin: ctx.appOrigin,
      referer,
      "user-agent": UA,
    },
    body: new URLSearchParams({ organization_id: ctx.organizationId }).toString(),
  });
  const raw = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: `Clerk token (${res.status}, non-JSON)`, status: res.status };
  }
  const jwt = extractClerkJwtFromJson(json);
  if (res.ok && jwt) return { ok: true, jwt };
  return { ok: false, error: `Clerk token (${res.status})`, status: res.status };
}

async function fetchClerkJwt(
  ctx: FetchCtx,
): Promise<{ ok: true; jwt: string } | { ok: false; error: string; status?: number }> {
  if (!ctx.sessionId || !ctx.clerkCookie) {
    return { ok: false, error: "Missing Clerk session for token refresh." };
  }
  const referers = [`${ctx.appOrigin.replace(/\/$/, "")}/`, `${ctx.clerkBase.replace(/\/$/, "")}/`];
  const sidFromCookie = extractSidFromClientCookie(ctx.clerkCookie);
  const sessionIds = [ctx.sessionId, ...(sidFromCookie && sidFromCookie !== ctx.sessionId ? [sidFromCookie] : [])];
  let last: { ok: false; error: string; status: number } | null = null;
  for (const sid of sessionIds) {
    for (const referer of referers) {
      const r = await fetchClerkJwtOnce({ ...ctx, sessionId: sid }, referer);
      if (r.ok) return r;
      last = r;
    }
  }
  return { ok: false, error: last?.error ?? "Clerk token failed", status: last?.status };
}

async function fetchClients(
  jwt: string,
  ctx: FetchCtx,
): Promise<{ ok: true; json: unknown } | { ok: false; status: number }> {
  const res = await fetch(`${ctx.backendUrl.replace(/\/$/, "")}/clients`, {
    method: "GET",
    headers: {
      accept: "*/*",
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      origin: ctx.appOrigin,
      referer: `${ctx.appOrigin}/`,
      "user-agent": UA,
    },
    signal: AbortSignal.timeout(CLIENTS_FETCH_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, json };
}

function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    bearerJwt?: unknown;
    clerkSessionId?: unknown;
    clerkCookie?: unknown;
    organizationId?: unknown;
    /** ISO — default: now minus 7 days */
    createdAfter?: unknown;
    /** ISO — default: now */
    createdBefore?: unknown;
    clientStatus?: unknown;
    fromCountry?: unknown;
    toCountry?: unknown;
    /** Max rows returned after filters (newest first). 0 or omit = all (cap 2000). */
    limit?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const nowMs = Date.now();
  const createdBeforeMs = parseCutoffDateMs(body.createdBefore) ?? nowMs;
  const createdAfterMs = parseCutoffDateMs(body.createdAfter) ?? nowMs - DEFAULT_WINDOW_MS;
  if (createdAfterMs > createdBeforeMs) {
    return NextResponse.json({ error: "createdAfter must be before createdBefore" }, { status: 400 });
  }

  const clientStatus = (str(body.clientStatus) || "processing").toLowerCase();
  const fromCountryFilter = str(body.fromCountry).toLowerCase();
  const toCountryFilter = str(body.toCountry).toLowerCase();
  const rawLimit = typeof body.limit === "number" ? body.limit : parseInt(str(body.limit), 10);
  const limit =
    Number.isNaN(rawLimit) || rawLimit <= 0 ? null : Math.min(Math.floor(rawLimit), 2000);

  const bearerJwtRaw = str(body.bearerJwt);
  const hasBearer = Boolean(bearerJwtRaw && bearerJwtRaw.split(".").length >= 2);
  const sessionId = str(body.clerkSessionId) || ENV_SESSION_ID;
  const clerkCookie = stripCookieHeaderPrefix(str(body.clerkCookie) || ENV_CLERK_COOKIE);
  const organizationId = str(body.organizationId) || ENV_ORGANIZATION_ID;

  if (!hasBearer && (!sessionId || !clerkCookie)) {
    return NextResponse.json(
      { error: "Sign in with Visaflow dashboard OTP or provide bearerJwt + Clerk session." },
      { status: 400 },
    );
  }

  const ctx: FetchCtx = {
    clerkBase: ENV_CLERK_BASE,
    backendUrl: ENV_BACKEND_URL,
    appOrigin: ENV_APP_ORIGIN,
    sessionId,
    clerkCookie,
    organizationId,
    clerkApiVersion: ENV_CLERK_API_VERSION,
    clerkJsVersion: ENV_CLERK_JS_VERSION,
  };

  let jwt = hasBearer ? bearerJwtRaw : "";
  if (!hasBearer) {
    const clerk1 = await fetchClerkJwt(ctx);
    if (!clerk1.ok) {
      return NextResponse.json({ error: clerk1.error }, { status: clerk1.status && clerk1.status >= 400 ? clerk1.status : 502 });
    }
    jwt = clerk1.jwt;
  }

  let clientsRes = await fetchClients(jwt, ctx);
  if (!clientsRes.ok && isAuthFailure(clientsRes.status) && sessionId && clerkCookie) {
    const clerk2 = await fetchClerkJwt(ctx);
    if (clerk2.ok) {
      jwt = clerk2.jwt;
      clientsRes = await fetchClients(jwt, ctx);
    }
  }
  if (!clientsRes.ok) {
    return NextResponse.json({ error: `GET /clients failed (${clientsRes.status})` }, { status: 502 });
  }

  const allRows = parseClientsToRows(clientsRes.json);
  const statusMatched = allRows.filter((r) => r.status === clientStatus);
  const dateMatched = statusMatched.filter(
    (r) => r.createdAtMs >= createdAfterMs && r.createdAtMs <= createdBeforeMs,
  );
  const routeMatched = dateMatched.filter((r) => {
    if (fromCountryFilter && r.fromCountry !== fromCountryFilter) return false;
    if (toCountryFilter && r.toCountry !== toCountryFilter) return false;
    return true;
  });
  const sorted = routeMatched.sort((a, b) => b.createdAtMs - a.createdAtMs);
  const matchedBeforeLimit = sorted.length;
  const rows = limit != null ? sorted.slice(0, limit) : sorted.slice(0, 2000);

  const refreshedBearerJwt = jwt !== bearerJwtRaw && jwt ? jwt : undefined;

  return NextResponse.json({
    totals: {
      clientsScanned: allRows.length,
      statusMatchedClients: statusMatched.length,
      matchedAfterDateFilter: dateMatched.length,
      matchedClients: matchedBeforeLimit,
      returnedClients: rows.length,
      limit: limit ?? null,
      clientStatus,
      fromCountry: fromCountryFilter || null,
      toCountry: toCountryFilter || null,
      createdAfter: new Date(createdAfterMs).toISOString(),
      createdBefore: new Date(createdBeforeMs).toISOString(),
    },
    rows,
    refreshedBearerJwt,
  });
}
