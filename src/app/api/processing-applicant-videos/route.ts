import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { stripCookieHeaderPrefix } from "@/lib/clerkVisaflowFapi";
import type { ApplicantImagesPayload } from "@/lib/visaflowDashboardPassports";

const ENV_CLERK_BASE = process.env.VISAFLOW_CLERK_BASE ?? "https://clerk.visaflow.devflexi.com";
const ENV_BACKEND_URL = process.env.VISAFLOW_BACKEND_URL ?? "https://visaflow-backend.getlawhat.com";
const ENV_APP_ORIGIN = process.env.VISAFLOW_APP_ORIGIN ?? "https://visaflow.devflexi.com";
const ENV_SESSION_ID = process.env.VISAFLOW_CLERK_SESSION_ID ?? "";
const ENV_CLERK_COOKIE = process.env.VISAFLOW_CLERK_COOKIE ?? "";
const ENV_ORGANIZATION_ID = process.env.VISAFLOW_ORGANIZATION_ID ?? "";
const ENV_CLERK_API_VERSION = process.env.VISAFLOW_CLERK_API_VERSION ?? "2025-11-10";
const ENV_CLERK_JS_VERSION = process.env.VISAFLOW_CLERK_JS_VERSION ?? "5.125.7";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

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

type ClientApplicant = {
  id: string;
  firstName: string;
  lastName: string;
  identityVerificationStatus: string;
  passportNumber: string;
};

type ClientEntry = {
  id: string;
  status: string;
  fromCountry: string;
  toCountry: string;
  applicants: ClientApplicant[];
};

export type ApplicantVideoRow = {
  clientId: string;
  applicantId: string;
  firstName: string;
  lastName: string;
  passportNumber: string;
  /** First passport image URL from dashboard (for liveness job JSON). */
  passportImageUrl: string;
  clientStatus: string;
  identityVerificationStatus: string;
  fromCountry: string;
  toCountry: string;
  videos: string[];
};

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
        "Missing Clerk session: set VISAFLOW_CLERK_SESSION_ID + VISAFLOW_CLERK_COOKIE on server, or send clerkSessionId + clerkCookie.",
    };
  }
  const referers = [`${ctx.appOrigin.replace(/\/$/, "")}/`, `${ctx.clerkBase.replace(/\/$/, "")}/`];
  const sidFromCookie = extractSidFromClientCookie(ctx.clerkCookie);
  const sessionIds = [ctx.sessionId, ...(sidFromCookie && sidFromCookie !== ctx.sessionId ? [sidFromCookie] : [])];

  let last: { ok: false; error: string; status: number } | null = null;
  for (const sid of sessionIds) {
    const ctxSid: FetchCtx = { ...ctx, sessionId: sid };
    for (const referer of referers) {
      const r = await fetchClerkJwtOnce(ctxSid, referer);
      if (r.ok) return r;
      last = r;
    }
  }

  return {
    ok: false,
    error: last?.error ?? "Clerk token failed",
    status: last?.status,
  };
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
  });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, json };
}

async function fetchApplicantImages(
  jwt: string,
  applicantId: string,
  ctx: FetchCtx,
): Promise<{ ok: true; data: ApplicantImagesPayload } | { ok: false; status: number }> {
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
  });
  if (!res.ok) return { ok: false, status: res.status };
  const data = (await res.json().catch(() => ({}))) as ApplicantImagesPayload;
  return { ok: true, data };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

function parseClientsPayload(json: unknown): ClientEntry[] {
  const root = json as Record<string, unknown>;
  const arr = Array.isArray(root?.data) ? (root.data as unknown[]) : [];
  const out: ClientEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const applicantsRaw = Array.isArray(c.applicants) ? c.applicants : [];
    const applicants: ClientApplicant[] = [];
    for (const apRaw of applicantsRaw) {
      if (!apRaw || typeof apRaw !== "object") continue;
      const ap = apRaw as Record<string, unknown>;
      if (typeof ap.id !== "string" || !ap.id) continue;
      applicants.push({
        id: ap.id,
        firstName: typeof ap.firstName === "string" ? ap.firstName : "",
        lastName: typeof ap.lastName === "string" ? ap.lastName : "",
        passportNumber: typeof ap.passportNumber === "string" ? ap.passportNumber : "",
        identityVerificationStatus:
          typeof ap.identityVerificationStatus === "string" ? ap.identityVerificationStatus.toLowerCase() : "",
      });
    }
    if (typeof c.id !== "string" || !c.id) continue;
    out.push({
      id: c.id,
      status: typeof c.status === "string" ? c.status.toLowerCase() : "",
      fromCountry: typeof c.fromCountry === "string" ? c.fromCountry.toLowerCase() : "",
      toCountry: typeof c.toCountry === "string" ? c.toCountry.toLowerCase() : "",
      applicants,
    });
  }
  return out;
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

/** Fisher–Yates shuffle so each request can pick a different slice of eligible applicants. */
function shuffleInPlace<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = items[i]!;
    const b = items[j]!;
    items[i] = b;
    items[j] = a;
  }
}

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
    clerkBase?: unknown;
    backendUrl?: unknown;
    appOrigin?: unknown;
    clerkApiVersion?: unknown;
    clerkJsVersion?: unknown;
    limit?: unknown;
    /** Client status filter (any route; e.g. pending, processing, pending_applicant). */
    clientWaitStatus?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const bearerJwtRaw = str(body.bearerJwt);
  const sessionId = str(body.clerkSessionId) || ENV_SESSION_ID;
  const clerkCookie = stripCookieHeaderPrefix(str(body.clerkCookie) || ENV_CLERK_COOKIE);
  const organizationId = str(body.organizationId) || ENV_ORGANIZATION_ID;
  const clerkBase = str(body.clerkBase) || ENV_CLERK_BASE;
  const backendUrl = str(body.backendUrl) || ENV_BACKEND_URL;
  const appOrigin = str(body.appOrigin) || ENV_APP_ORIGIN;
  const clerkApiVersion = str(body.clerkApiVersion) || ENV_CLERK_API_VERSION;
  const clerkJsVersion = str(body.clerkJsVersion) || ENV_CLERK_JS_VERSION;

  const rawLimit = typeof body.limit === "number" ? body.limit : parseInt(str(body.limit), 10);
  const applicantLimit = isNaN(rawLimit) || rawLimit <= 0 ? 50 : Math.min(rawLimit, 500);
  const clientWaitStatus = (str(body.clientWaitStatus) || "pending_applicant").toLowerCase();

  const hasBearer = Boolean(bearerJwtRaw && bearerJwtRaw.split(".").length >= 2);
  if (!hasBearer && (!sessionId || !clerkCookie)) {
    return NextResponse.json(
      {
        error:
          "Use email OTP sign-in (stores JWT) or paste Clerk session id + cookie / env VISAFLOW_CLERK_*.",
      },
      { status: 400 },
    );
  }

  const ctx: FetchCtx = {
    clerkBase,
    backendUrl,
    appOrigin,
    sessionId,
    clerkCookie,
    organizationId,
    clerkApiVersion,
    clerkJsVersion,
  };

  const initialBearerJwt = hasBearer ? bearerJwtRaw : "";
  let jwt = bearerJwtRaw;
  if (!hasBearer) {
    const clerk1 = await fetchClerkJwt(ctx);
    if (!clerk1.ok) {
      return NextResponse.json(
        {
          error: clerk1.error,
          rows: [],
          totals: {
            clientsScanned: 0,
            clientsMatchedCountry: 0,
            clientWaitStatus,
            statusMatchedClients: 0,
            applicantsFound: 0,
            applicantsWithVideos: 0,
            applicantsWithoutVideos: 0,
            completedIdentityApplicantsTotal: 0,
            targetLimit: 0,
            matchedApplicantsReturned: 0,
            completedIdentityApplicantsScanned: 0,
            stoppedEarly: false,
            stopReason: null,
          },
        },
        { status: clerk1.status && clerk1.status >= 400 ? clerk1.status : 502 },
      );
    }
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
    return NextResponse.json({ error: `GET /clients failed (${clientsRes.status})` }, { status: 502 });
  }

  const clients = parseClientsPayload(clientsRes.json);
  const statusMatchedClients = clients.filter((c) => c.status === clientWaitStatus);

  /** All applicants under matching-status clients (any route; for totals / scan order). */
  const allCandidates: Array<{ client: ClientEntry; applicant: ClientApplicant }> = [];
  for (const client of statusMatchedClients) {
    for (const applicant of client.applicants) {
      allCandidates.push({ client, applicant });
    }
  }

  const completedIdentityCandidates = allCandidates.filter(
    ({ applicant }) => applicant.identityVerificationStatus === "completed",
  );
  shuffleInPlace(completedIdentityCandidates);

  /** Max completed-identity applicants to fetch images for before giving up (safety + “keep scanning”). */
  const maxCompletedIdentityToScan = Math.min(
    completedIdentityCandidates.length,
    3000,
    Math.max(150, applicantLimit * 40),
  );

  const rows: ApplicantVideoRow[] = [];
  let scanEnd = 0;

  for (let start = 0; start < maxCompletedIdentityToScan && rows.length < applicantLimit; start += 6) {
    const end = Math.min(start + 6, maxCompletedIdentityToScan);
    scanEnd = end;
    const batch = completedIdentityCandidates.slice(start, end);
    const batchResults = await mapWithConcurrency(batch, 6, async (entry) => {
      let img = await fetchApplicantImages(jwt, entry.applicant.id, ctx);
      if (!img.ok && isAuthFailure(img.status) && ctx.sessionId && ctx.clerkCookie) {
        const clerkR = await fetchClerkJwt(ctx);
        if (clerkR.ok) {
          jwt = clerkR.jwt;
          img = await fetchApplicantImages(jwt, entry.applicant.id, ctx);
        }
      }
      const videos: string[] = img.ok
        ? (Array.isArray(img.data.images?.videos)
            ? img.data.images!.videos!.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            : [])
        : [];
      const passportImages =
        img.ok && Array.isArray(img.data.images?.passportImages)
          ? img.data.images!.passportImages!.filter(
              (p): p is { id: string; url: string } =>
                p != null &&
                typeof p === "object" &&
                typeof (p as { url?: unknown }).url === "string" &&
                (p as { url: string }).url.trim().length > 0,
            )
          : [];
      const passportImageUrl = passportImages[0]?.url?.trim() ?? "";
      if (!passportImageUrl || videos.length === 0) return null;

      const row: ApplicantVideoRow = {
        clientId: entry.client.id,
        applicantId: entry.applicant.id,
        firstName: entry.applicant.firstName,
        lastName: entry.applicant.lastName,
        passportNumber: entry.applicant.passportNumber,
        passportImageUrl,
        clientStatus: entry.client.status,
        identityVerificationStatus: entry.applicant.identityVerificationStatus,
        fromCountry: entry.client.fromCountry,
        toCountry: entry.client.toCountry,
        videos,
      };
      return row;
    });

    for (const r of batchResults) {
      if (r != null && rows.length < applicantLimit) rows.push(r);
    }
  }

  shuffleInPlace(rows);

  const hitScanCap =
    scanEnd >= maxCompletedIdentityToScan && maxCompletedIdentityToScan < completedIdentityCandidates.length;
  const exhaustedCompletedIdentity = scanEnd >= completedIdentityCandidates.length;

  return NextResponse.json({
    totals: {
      clientsScanned: clients.length,
      /** @deprecated kept for UI compat — same as clientsScanned (no country filter). */
      clientsMatchedCountry: clients.length,
      clientWaitStatus,
      statusMatchedClients: statusMatchedClients.length,
      /** @deprecated use statusMatchedClients */
      pendingClients: statusMatchedClients.length,
      applicantsFound: allCandidates.length,
      completedIdentityApplicantsTotal: completedIdentityCandidates.length,
      targetLimit: applicantLimit,
      matchedApplicantsReturned: rows.length,
      completedIdentityApplicantsScanned: scanEnd,
      stoppedEarly: rows.length < applicantLimit,
      stopReason:
        rows.length >= applicantLimit
          ? null
          : hitScanCap
            ? "scan_cap"
            : exhaustedCompletedIdentity
              ? "exhausted"
              : null,
      applicantsWithVideos: rows.length,
      applicantsWithoutVideos: 0,
    },
    rows,
    ...(hasBearer && initialBearerJwt && jwt !== initialBearerJwt ? { refreshedBearerJwt: jwt } : {}),
  });
}
