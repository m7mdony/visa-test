import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { stripCookieHeaderPrefix } from "@/lib/clerkVisaflowFapi";
import {
  buildEmailToRouteFromClientsPayload,
  buildRouteCombinationOptions,
  buildRouteFilterOptions,
  collectPassportRoutesFromClientsPayload,
  indexPassportRoutes,
  type PassportRouteInfo,
} from "@/lib/visaflowDashboardClients";
import { normalizePassportKey } from "@/lib/visaflowDashboardPassports";

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
    let val = trimmed.slice("__client=".length).trim();
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

async function fetchClerkJwt(ctx: FetchCtx): Promise<{ ok: true; jwt: string } | { ok: false; error: string }> {
  const referers = [`${ctx.appOrigin.replace(/\/$/, "")}/`, `${ctx.clerkBase.replace(/\/$/, "")}/`];
  const sessionIds = [
    ctx.sessionId,
    ...(extractSidFromClientCookie(ctx.clerkCookie) !== ctx.sessionId
      ? [extractSidFromClientCookie(ctx.clerkCookie)!]
      : []),
  ].filter(Boolean);
  let lastErr = "Clerk token failed";
  for (const sid of [...new Set(sessionIds)]) {
    const ctxSid = { ...ctx, sessionId: sid };
    for (const referer of [...new Set(referers)]) {
      const res = await fetch(clerkTokenUrl(ctxSid), {
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
        json = JSON.parse(raw);
      } catch {
        lastErr = `Clerk token (${res.status}, non-JSON)`;
        continue;
      }
      const jwt = extractClerkJwtFromJson(json);
      if (res.ok && jwt) return { ok: true, jwt };
      lastErr = `Clerk token (${res.status})`;
    }
  }
  return { ok: false, error: lastErr };
}

async function fetchClients(jwt: string, ctx: FetchCtx): Promise<{ ok: true; json: unknown } | { ok: false; status: number }> {
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
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, json };
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    passportNumbers?: unknown;
    emails?: unknown;
    bearerJwt?: unknown;
    clerkSessionId?: unknown;
    clerkCookie?: unknown;
    organizationId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const bearerJwtRaw = str(body.bearerJwt);
  const hasBearer = Boolean(bearerJwtRaw && bearerJwtRaw.split(".").length >= 2);
  const sessionId = str(body.clerkSessionId) || ENV_SESSION_ID;
  const clerkCookie = stripCookieHeaderPrefix(str(body.clerkCookie) || ENV_CLERK_COOKIE);
  if (!hasBearer && (!sessionId || !clerkCookie)) {
    return NextResponse.json(
      { error: "Dashboard JWT or Clerk session required for route lookup." },
      { status: 400 }
    );
  }

  const ctx: FetchCtx = {
    clerkBase: ENV_CLERK_BASE,
    backendUrl: ENV_BACKEND_URL,
    appOrigin: ENV_APP_ORIGIN,
    sessionId,
    clerkCookie,
    organizationId: str(body.organizationId) || ENV_ORGANIZATION_ID,
    clerkApiVersion: ENV_CLERK_API_VERSION,
    clerkJsVersion: ENV_CLERK_JS_VERSION,
  };

  let jwt = hasBearer ? bearerJwtRaw : "";
  if (!hasBearer) {
    const clerk = await fetchClerkJwt(ctx);
    if (!clerk.ok) return NextResponse.json({ error: clerk.error }, { status: 502 });
    jwt = clerk.jwt;
  }

  let clientsRes = await fetchClients(jwt, ctx);
  if (!clientsRes.ok && sessionId && clerkCookie) {
    const clerk = await fetchClerkJwt(ctx);
    if (clerk.ok) {
      jwt = clerk.jwt;
      clientsRes = await fetchClients(jwt, ctx);
    }
  }
  if (!clientsRes.ok) {
    return NextResponse.json({ error: `GET /clients failed (${clientsRes.status})` }, { status: 502 });
  }

  const allRoutes = collectPassportRoutesFromClientsPayload(clientsRes.json);
  const routesByKey = indexPassportRoutes(allRoutes);
  const emailToRoute = buildEmailToRouteFromClientsPayload(clientsRes.json);

  const rawList = body.passportNumbers;
  const requestedPassports =
    Array.isArray(rawList) && rawList.length > 0
      ? [...new Set(rawList.map((x) => normalizePassportKey(String(x ?? ""))).filter(Boolean))]
      : [];

  const rawEmails = body.emails;
  const requestedEmails =
    Array.isArray(rawEmails) && rawEmails.length > 0
      ? [...new Set(rawEmails.map((x) => String(x ?? "").trim().toLowerCase()).filter((e) => e.includes("@")))]
      : [];

  const routesForReport: PassportRouteInfo[] = [];
  const seenRouteKeys = new Set<string>();
  const addRoute = (route: PassportRouteInfo | undefined) => {
    if (!route?.normalizedKey || seenRouteKeys.has(route.normalizedKey)) return;
    seenRouteKeys.add(route.normalizedKey);
    routesForReport.push(route);
  };

  const missingPassports: string[] = [];
  for (const key of requestedPassports) {
    const route = routesByKey.get(key);
    if (route) addRoute(route);
    else missingPassports.push(key);
  }
  for (const email of requestedEmails) {
    addRoute(emailToRoute.get(email));
  }

  const filterSource = routesForReport.length > 0 ? routesForReport : allRoutes;
  const emailToRouteObj: Record<string, PassportRouteInfo> = {};
  for (const email of requestedEmails) {
    const route = emailToRoute.get(email);
    if (route) emailToRouteObj[email] = route;
  }

  return NextResponse.json({
    routes: routesForReport,
    routesInDashboard: allRoutes.length,
    missingPassports,
    filterOptions: buildRouteFilterOptions(filterSource),
    routeCombinations: buildRouteCombinationOptions(filterSource),
    emailToRoute: emailToRouteObj,
    ...(hasBearer && jwt !== bearerJwtRaw ? { refreshedBearerJwt: jwt } : {}),
  });
}
