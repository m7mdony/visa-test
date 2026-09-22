import { stripCookieHeaderPrefix } from "@/lib/clerkVisaflowFapi";
import {
  collectPassportRoutesFromClientsPayload,
  indexPassportRoutes,
} from "@/lib/visaflowDashboardClients";
import {
  emptyDashboardFetchDebug,
  summarizeClientsJson,
  summarizeJwt,
  type DashboardFetchDebug,
} from "@/lib/visaflowDashboardDebug";
import {
  collectApplicantsFromPayload,
  findApplicantIdByPassport,
  indexApplicantIdsByPassport,
  isDashboardApplicantId,
  normalizePassportKey,
  parseGestureClipsFromApplicantImages,
  parseVideosFromApplicantImages,
  type ApplicantImagesPayload,
  type GestureClipEntry,
  type PassportImageEntry,
} from "@/lib/visaflowDashboardPassports";

export type { DashboardFetchDebug };

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

const BACKEND_FETCH_TIMEOUT_MS = 45_000;
const CLIENTS_FETCH_TIMEOUT_MS = 120_000;
const APPLICANT_IMAGES_CONCURRENCY = 8;

export type DashboardMediaResult = {
  applicantId: string | null;
  applicant?: ApplicantImagesPayload["applicant"];
  passportImages: PassportImageEntry[];
  videos: string[];
  gestureClips: GestureClipEntry[];
  error?: string;
};

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

function backendFetchTimeoutSignal(ms = BACKEND_FETCH_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const safeLimit = Math.max(1, Math.min(limit, items.length));
  const out = new Array<R>(items.length);
  let cursor = 0;
  async function runOne() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      out[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: safeLimit }, () => runOne()));
  return out;
}

function fetchErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
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

function clerkErrorsToString(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const o = json as Record<string, unknown>;
  if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
  const errors = o.errors;
  if (Array.isArray(errors)) {
    const parts = errors
      .map((e) => {
        if (!e || typeof e !== "object") return "";
        const er = e as Record<string, unknown>;
        return String(er.long_message ?? er.message ?? "").trim();
      })
      .filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  try {
    return JSON.stringify(json).slice(0, 420);
  } catch {
    return "";
  }
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
    return {
      ok: false,
      error: `Clerk token (${res.status}, non-JSON): ${raw.slice(0, 200).replace(/\s+/g, " ")}`,
      status: res.status,
    };
  }
  const jwt = extractClerkJwtFromJson(json);
  if (res.ok && jwt) return { ok: true, jwt };
  const detail = clerkErrorsToString(json) || (jwt ? "response not OK despite jwt" : "no jwt in JSON body");
  return { ok: false, error: `Clerk token (${res.status}): ${detail}`, status: res.status };
}

async function fetchClerkJwt(
  ctx: FetchCtx,
): Promise<{ ok: true; jwt: string } | { ok: false; error: string; status?: number }> {
  if (!ctx.sessionId || !ctx.clerkCookie) {
    return {
      ok: false,
      error:
        "Missing Clerk session: sign in with Visaflow dashboard OTP or send clerkSessionId + clerkCookie.",
    };
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
): Promise<
  | { ok: true; json: unknown; status: number; rawText: string; parseError: string | null }
  | { ok: false; status: number; error?: string; json?: unknown; rawText?: string; parseError?: string | null }
> {
  try {
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
      signal: backendFetchTimeoutSignal(CLIENTS_FETCH_TIMEOUT_MS),
    });
    const rawText = await res.text();
    let json: unknown = null;
    let parseError: string | null = null;
    if (!rawText.trim()) {
      parseError = "empty response body";
      json = {};
    } else {
      try {
        json = JSON.parse(rawText) as unknown;
      } catch (e) {
        parseError = e instanceof Error ? e.message : "JSON parse failed";
        json = {};
      }
    }
    if (!res.ok) {
      const root = json as Record<string, unknown>;
      const msg =
        typeof root?.error === "string"
          ? root.error
          : typeof root?.message === "string"
            ? root.message
            : parseError ?? undefined;
      return { ok: false, status: res.status, error: msg, json, rawText, parseError };
    }
    return { ok: true, json, status: res.status, rawText, parseError };
  } catch (err) {
    return { ok: false, status: 0, error: fetchErrorMessage(err) };
  }
}

function clientsResponseEmpty(summary: ReturnType<typeof summarizeClientsJson>): boolean {
  if (summary.parseError === "empty response body") return true;
  if (summary.rawTextLength === 0) return true;
  if (summary.clientsCount === 0 && summary.topKeys.length === 0) return true;
  if (summary.success === true && summary.clientsCount === 0 && !summary.dataIsArray) return true;
  return false;
}

function summarizeClientsRes(
  res: { ok: true; json: unknown; status: number; rawText: string; parseError: string | null },
): ReturnType<typeof summarizeClientsJson> {
  return summarizeClientsJson(res.json, res.status, res.rawText.length, res.parseError);
}

async function fetchApplicantImages(
  jwt: string,
  applicantId: string,
  ctx: FetchCtx,
): Promise<{ ok: true; data: ApplicantImagesPayload } | { ok: false; status: number; body: string }> {
  try {
    const res = await fetch(`${ctx.backendUrl.replace(/\/$/, "")}/applicants/images/${applicantId}`, {
      method: "GET",
      headers: {
        accept: "*/*",
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        origin: ctx.appOrigin,
        referer: `${ctx.appOrigin}/`,
        "user-agent": UA,
      },
      signal: backendFetchTimeoutSignal(),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, body: text.slice(0, 500) };
    return { ok: true, data: JSON.parse(text) as ApplicantImagesPayload };
  } catch (err) {
    return { ok: false, status: 0, body: fetchErrorMessage(err).slice(0, 500) };
  }
}

function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

export function buildDashboardFetchCtx(body: Record<string, unknown>): FetchCtx {
  return {
    clerkBase: str(body.clerkBase) || ENV_CLERK_BASE,
    backendUrl: str(body.backendUrl) || ENV_BACKEND_URL,
    appOrigin: str(body.appOrigin) || ENV_APP_ORIGIN,
    sessionId: str(body.clerkSessionId) || ENV_SESSION_ID,
    clerkCookie: stripCookieHeaderPrefix(str(body.clerkCookie) || ENV_CLERK_COOKIE),
    organizationId: str(body.organizationId) || ENV_ORGANIZATION_ID,
    clerkApiVersion: str(body.clerkApiVersion) || ENV_CLERK_API_VERSION,
    clerkJsVersion: str(body.clerkJsVersion) || ENV_CLERK_JS_VERSION,
  };
}

export async function fetchDashboardMediaForPassports(params: {
  body: Record<string, unknown>;
  passportNumbers: string[];
}): Promise<{
  byPassport: Record<string, DashboardMediaResult>;
  clientsApplicantsScanned?: number;
  clientsCount?: number;
  refreshedBearerJwt?: string;
  error?: string;
  debug?: DashboardFetchDebug;
}> {
  const { body, passportNumbers } = params;
  const ctx = buildDashboardFetchCtx(body);
  const debug = emptyDashboardFetchDebug();
  debug.auth.backendUrl = ctx.backendUrl;
  debug.auth.hasBearerFromRequest = Boolean(str(body.bearerJwt));
  debug.auth.bearerSegmentCount = str(body.bearerJwt).split(".").length;
  debug.auth.hasClerkSession = Boolean(ctx.sessionId?.startsWith("sess_"));
  debug.auth.hasClerkCookie = Boolean(ctx.clerkCookie);
  debug.auth.organizationIdSet = Boolean(ctx.organizationId);

  const bearerJwtRaw = str(body.bearerJwt);
  const hasBearer = Boolean(bearerJwtRaw && bearerJwtRaw.split(".").length >= 2);
  const initialBearerJwt = hasBearer ? bearerJwtRaw : "";

  let jwt = "";
  let jwtSource: DashboardFetchDebug["auth"]["jwtSource"] = "none";
  let clerkMintJwt = "";

  const bearerSummary = hasBearer ? summarizeJwt(bearerJwtRaw) : null;

  // OTP verify JWT works with GET /clients; Clerk /tokens mint without org often returns empty {}.
  if (hasBearer && bearerSummary && !bearerSummary.expired) {
    debug.steps.push("bearer-otp-first");
    jwt = bearerJwtRaw;
    jwtSource = "bearer-otp";
  } else if (ctx.sessionId && ctx.clerkCookie) {
    debug.steps.push("clerk-mint-no-fresh-bearer");
    const clerk1 = await fetchClerkJwt(ctx);
    if (clerk1.ok) {
      clerkMintJwt = clerk1.jwt;
      jwt = clerk1.jwt;
      jwtSource = "clerk-mint";
      debug.auth.jwtAfterRefresh = summarizeJwt(jwt);
    } else {
      debug.clerkMintError = clerk1.error;
      debug.steps.push(`clerk-mint-failed:${clerk1.error.slice(0, 80)}`);
    }
  }

  if (!jwt && hasBearer) {
    debug.steps.push("fallback-bearer-cache");
    jwt = bearerJwtRaw;
    jwtSource = "bearer-cache";
  }

  if (!jwt) {
    debug.auth.jwtSource = "none";
    return {
      byPassport: {},
      error: debug.clerkMintError ?? "No JWT — sign in with Visaflow dashboard OTP",
      debug,
    };
  }

  debug.auth.jwtSource = jwtSource;
  debug.auth.jwtBeforeClients = summarizeJwt(jwt);

  let clientsRes = await fetchClients(jwt, ctx);

  async function tryClerkMint(): Promise<boolean> {
    if (!ctx.sessionId || !ctx.clerkCookie) return false;
    const clerk = await fetchClerkJwt(ctx);
    if (!clerk.ok) {
      debug.clerkRetryError = clerk.error;
      return false;
    }
    clerkMintJwt = clerk.jwt;
    jwt = clerk.jwt;
    jwtSource = "clerk-retry-after-empty";
    debug.auth.jwtSource = jwtSource;
    debug.auth.jwtAfterRefresh = summarizeJwt(jwt);
    clientsRes = await fetchClients(jwt, ctx);
    return clientsRes.ok;
  }

  if (!clientsRes.ok && isAuthFailure(clientsRes.status)) {
    debug.steps.push(`clients-auth-fail-${clientsRes.status}`);
    if (jwtSource === "bearer-otp" || jwtSource === "bearer-cache") {
      debug.steps.push("retry-clerk-after-auth-fail");
      await tryClerkMint();
    } else if (hasBearer) {
      debug.steps.push("retry-bearer-after-auth-fail");
      jwt = bearerJwtRaw;
      jwtSource = "bearer-retry-after-empty";
      debug.auth.jwtSource = jwtSource;
      clientsRes = await fetchClients(jwt, ctx);
    }
  }

  if (!clientsRes.ok) {
    const detail =
      "error" in clientsRes && clientsRes.error
        ? clientsRes.error
        : `GET /clients failed (${clientsRes.status})`;
    const failRaw = "rawText" in clientsRes ? clientsRes.rawText ?? "" : "";
    debug.clients = {
      httpStatus: clientsRes.status,
      ...summarizeClientsJson(
        "json" in clientsRes ? clientsRes.json : {},
        clientsRes.status,
        failRaw.length,
        "parseError" in clientsRes ? (clientsRes.parseError ?? null) : null,
      ),
    };
    debug.steps.push(`clients-http-${clientsRes.status}`);
    console.log("[dashboard-fetch] clients failed", JSON.stringify(debug));
    return { byPassport: {}, error: detail, debug };
  }

  let clientsSummary = summarizeClientsRes(clientsRes);
  debug.clients = { httpStatus: clientsRes.status, ...clientsSummary };
  debug.steps.push(`clients-ok:${clientsSummary.clientsCount}c/${clientsSummary.applicantsCount}a`);

  if (clientsResponseEmpty(clientsSummary)) {
    if (jwtSource === "clerk-mint" && hasBearer) {
      debug.steps.push("clients-empty-retry-bearer-otp");
      jwt = bearerJwtRaw;
      jwtSource = "bearer-retry-after-empty";
      debug.auth.jwtSource = jwtSource;
      debug.auth.jwtBeforeClients = summarizeJwt(jwt);
      clientsRes = await fetchClients(jwt, ctx);
      if (clientsRes.ok) {
        clientsSummary = summarizeClientsRes(clientsRes);
        debug.clients = { httpStatus: clientsRes.status, ...clientsSummary };
        debug.steps.push(`bearer-retry-ok:${clientsSummary.clientsCount}c/${clientsSummary.applicantsCount}a`);
      }
    } else if (
      (jwtSource === "bearer-otp" || jwtSource === "bearer-cache") &&
      ctx.sessionId &&
      ctx.clerkCookie &&
      !clerkMintJwt
    ) {
      debug.steps.push("clients-empty-retry-clerk");
      if (await tryClerkMint()) {
        clientsSummary = summarizeClientsRes(clientsRes);
        debug.clients = { httpStatus: clientsRes.status, ...clientsSummary };
        debug.steps.push(`clerk-retry-ok:${clientsSummary.clientsCount}c/${clientsSummary.applicantsCount}a`);
      }
    }
  }

  const clientsCount = clientsSummary.clientsCount;
  const applicants = collectApplicantsFromPayload(clientsRes.json);
  const routesByPassport = indexPassportRoutes(collectPassportRoutesFromClientsPayload(clientsRes.json));
  const applicantsByPassport = indexApplicantIdsByPassport(applicants);
  const byPassport: Record<string, DashboardMediaResult> = {};
  const lookupHint =
    applicants.length === 0
      ? `GET /clients returned 0 applicants (${clientsCount} clients) — re-sign in to dashboard`
      : `scanned ${applicants.length} applicants in ${clientsCount} clients`;

  const passportToApplicantId = new Map<string, string>();
  for (const pn of passportNumbers) {
    const norm = normalizePassportKey(pn);
    const routeHit = norm ? routesByPassport.get(norm) : undefined;
    const applicantId =
      routeHit?.applicantId ??
      (norm ? applicantsByPassport.get(norm) : undefined) ??
      findApplicantIdByPassport(applicants, pn);
    if (applicantId && isDashboardApplicantId(applicantId)) {
      passportToApplicantId.set(pn, applicantId);
    } else {
      const miss: DashboardMediaResult = {
        applicantId: null,
        passportImages: [],
        videos: [],
        gestureClips: [],
        error: `Applicant not found for passport ${pn.trim()} (${lookupHint})`,
      };
      byPassport[pn] = miss;
      if (norm) byPassport[norm] = miss;
    }
  }

  const uniqueApplicantIds = [...new Set(passportToApplicantId.values())];
  debug.steps.push(`fetch-images:${uniqueApplicantIds.length}ids`);

  async function loadApplicantImages(applicantId: string): Promise<DashboardMediaResult> {
    let img = await fetchApplicantImages(jwt, applicantId, ctx);
    if (!img.ok && isAuthFailure(img.status) && ctx.sessionId && ctx.clerkCookie) {
      const clerkR = await fetchClerkJwt(ctx);
      if (clerkR.ok) {
        jwt = clerkR.jwt;
        img = await fetchApplicantImages(jwt, applicantId, ctx);
      }
    }
    if (!img.ok) {
      const detail =
        img.status > 0
          ? `GET /applicants/images failed (${img.status})${img.body ? `: ${img.body.slice(0, 120)}` : ""}`
          : img.body || "GET /applicants/images failed";
      return {
        applicantId,
        passportImages: [],
        videos: [],
        gestureClips: [],
        error: detail,
      };
    }
    const imgs = img.data.images?.passportImages ?? [];
    return {
      applicantId,
      applicant: img.data.applicant,
      passportImages: imgs.filter((p) => p && typeof p.url === "string" && p.url),
      videos: parseVideosFromApplicantImages(img.data),
      gestureClips: parseGestureClipsFromApplicantImages(img.data),
    };
  }

  const imageResults = await mapWithConcurrency(
    uniqueApplicantIds,
    APPLICANT_IMAGES_CONCURRENCY,
    (applicantId) => loadApplicantImages(applicantId),
  );
  const imageByApplicantId = new Map<string, DashboardMediaResult>();
  for (let i = 0; i < uniqueApplicantIds.length; i++) {
    imageByApplicantId.set(uniqueApplicantIds[i], imageResults[i]);
  }

  for (const pn of passportNumbers) {
    const applicantId = passportToApplicantId.get(pn);
    if (!applicantId) continue;
    const cached = imageByApplicantId.get(applicantId);
    if (!cached) continue;
    byPassport[pn] = cached;
    const norm = normalizePassportKey(pn);
    if (norm) byPassport[norm] = cached;
  }

  if (clientsCount === 0 || applicants.length === 0) {
    console.log("[dashboard-fetch] empty clients/applicants", JSON.stringify(debug));
  }

  return {
    byPassport,
    clientsApplicantsScanned: applicants.length,
    clientsCount,
    debug,
    ...(jwt && jwt !== initialBearerJwt ? { refreshedBearerJwt: jwt } : {}),
  };
}

export async function fetchDashboardMediaForApplicantIds(params: {
  body: Record<string, unknown>;
  applicantIds: string[];
}): Promise<{
  byApplicantId: Record<string, DashboardMediaResult>;
  refreshedBearerJwt?: string;
  error?: string;
}> {
  const { body, applicantIds } = params;
  const ctx = buildDashboardFetchCtx(body);
  const bearerJwtRaw = str(body.bearerJwt);
  const hasBearer = Boolean(bearerJwtRaw && bearerJwtRaw.split(".").length >= 2);
  const initialBearerJwt = hasBearer ? bearerJwtRaw : "";

  let jwt: string;
  if (hasBearer) {
    jwt = bearerJwtRaw;
  } else {
    const clerk1 = await fetchClerkJwt(ctx);
    if (!clerk1.ok) return { byApplicantId: {}, error: clerk1.error };
    jwt = clerk1.jwt;
  }

  const uniqueIds = [...new Set(applicantIds.map((id) => id.trim()).filter(Boolean))];
  const byApplicantId: Record<string, DashboardMediaResult> = {};

  for (const applicantId of uniqueIds) {
    if (!isDashboardApplicantId(applicantId)) {
      byApplicantId[applicantId] = {
        applicantId,
        passportImages: [],
        videos: [],
        gestureClips: [],
        error: "Invalid applicant id (Redis clientId, not dashboard UUID)",
      };
      continue;
    }
    let img = await fetchApplicantImages(jwt, applicantId, ctx);
    if (!img.ok && isAuthFailure(img.status) && ctx.sessionId && ctx.clerkCookie) {
      const clerkR = await fetchClerkJwt(ctx);
      if (clerkR.ok) {
        jwt = clerkR.jwt;
        img = await fetchApplicantImages(jwt, applicantId, ctx);
      }
    }
    if (!img.ok) {
      const detail =
        img.status > 0
          ? `GET /applicants/images failed (${img.status})${img.body ? `: ${img.body.slice(0, 120)}` : ""}`
          : img.body || "GET /applicants/images failed";
      byApplicantId[applicantId] = {
        applicantId,
        passportImages: [],
        videos: [],
        gestureClips: [],
        error: detail,
      };
      continue;
    }
    const imgs = img.data.images?.passportImages ?? [];
    byApplicantId[applicantId] = {
      applicantId,
      applicant: img.data.applicant,
      passportImages: imgs.filter((p) => p && typeof p.url === "string" && p.url),
      videos: parseVideosFromApplicantImages(img.data),
      gestureClips: parseGestureClipsFromApplicantImages(img.data),
    };
  }

  return {
    byApplicantId,
    ...(hasBearer && initialBearerJwt && jwt !== initialBearerJwt ? { refreshedBearerJwt: jwt } : {}),
  };
}
