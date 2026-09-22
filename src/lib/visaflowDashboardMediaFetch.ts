import { stripCookieHeaderPrefix } from "@/lib/clerkVisaflowFapi";
import {
  collectApplicantsFromPayload,
  findApplicantIdByPassport,
  normalizePassportKey,
  parseGestureClipsFromApplicantImages,
  parseVideosFromApplicantImages,
  type ApplicantImagesPayload,
  type GestureClipEntry,
  type PassportImageEntry,
} from "@/lib/visaflowDashboardPassports";

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

const BACKEND_FETCH_TIMEOUT_MS = 25_000;

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

function backendFetchTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS);
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
): Promise<{ ok: true; json: unknown } | { ok: false; status: number; error?: string }> {
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
      signal: backendFetchTimeoutSignal(),
    });
    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, json };
  } catch (err) {
    return { ok: false, status: 0, error: fetchErrorMessage(err) };
  }
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
  refreshedBearerJwt?: string;
  error?: string;
}> {
  const { body, passportNumbers } = params;
  const ctx = buildDashboardFetchCtx(body);
  const bearerJwtRaw = str(body.bearerJwt);
  const hasBearer = Boolean(bearerJwtRaw && bearerJwtRaw.split(".").length >= 2);
  const initialBearerJwt = hasBearer ? bearerJwtRaw : "";

  let jwt: string;
  if (hasBearer) {
    jwt = bearerJwtRaw;
  } else {
    const clerk1 = await fetchClerkJwt(ctx);
    if (!clerk1.ok) return { byPassport: {}, error: clerk1.error };
    jwt = clerk1.jwt;
  }

  let clientsRes = await fetchClients(jwt, ctx);
  if (!clientsRes.ok && isAuthFailure(clientsRes.status) && ctx.sessionId && ctx.clerkCookie) {
    const clerk2 = await fetchClerkJwt(ctx);
    if (clerk2.ok) {
      jwt = clerk2.jwt;
      clientsRes = await fetchClients(jwt, ctx);
    }
  }
  if (!clientsRes.ok) {
    const detail =
      "error" in clientsRes && clientsRes.error
        ? clientsRes.error
        : `GET /clients failed (${clientsRes.status})`;
    return { byPassport: {}, error: detail };
  }

  const applicants = collectApplicantsFromPayload(clientsRes.json);
  const byPassport: Record<string, DashboardMediaResult> = {};
  const seenApplicantIds = new Map<string, DashboardMediaResult>();

  for (const pn of passportNumbers) {
    const applicantId = findApplicantIdByPassport(applicants, pn);
    if (!applicantId) {
      const miss: DashboardMediaResult = {
        applicantId: null,
        passportImages: [],
        videos: [],
        gestureClips: [],
        error: "Applicant not found for passport",
      };
      byPassport[pn] = miss;
      const norm = normalizePassportKey(pn);
      if (norm) byPassport[norm] = miss;
      continue;
    }

    let cached = seenApplicantIds.get(applicantId);
    if (!cached) {
      let img = await fetchApplicantImages(jwt, applicantId, ctx);
      if (!img.ok && isAuthFailure(img.status) && ctx.sessionId && ctx.clerkCookie) {
        const clerkR = await fetchClerkJwt(ctx);
        if (clerkR.ok) {
          jwt = clerkR.jwt;
          img = await fetchApplicantImages(jwt, applicantId, ctx);
        }
      }
      if (!img.ok) {
        cached = {
          applicantId,
          passportImages: [],
          videos: [],
          gestureClips: [],
          error:
            img.status > 0
              ? `GET /applicants/images failed (${img.status})`
              : img.body || "GET /applicants/images failed",
        };
      } else {
        const imgs = img.data.images?.passportImages ?? [];
        cached = {
          applicantId,
          applicant: img.data.applicant,
          passportImages: imgs.filter((p) => p && typeof p.url === "string" && p.url),
          videos: parseVideosFromApplicantImages(img.data),
          gestureClips: parseGestureClipsFromApplicantImages(img.data),
        };
      }
      seenApplicantIds.set(applicantId, cached);
    }

    byPassport[pn] = cached;
    const norm = normalizePassportKey(pn);
    if (norm) byPassport[norm] = cached;
  }

  return {
    byPassport,
    ...(hasBearer && initialBearerJwt && jwt !== initialBearerJwt ? { refreshedBearerJwt: jwt } : {}),
  };
}
