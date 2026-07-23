import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  CLERK_FAPI_UA,
  DEFAULT_APP_ORIGIN,
  DEFAULT_CLERK_API_VERSION,
  DEFAULT_CLERK_BASE,
  DEFAULT_CLERK_JS_VERSION,
  clerkFapiQuery,
  clerkJsonErrorSummary,
  getSetCookieLines,
  mergeCookieJar,
  stripCookieHeaderPrefix,
} from "@/lib/clerkVisaflowFapi";

const ENV_ORGANIZATION_ID = process.env.VISAFLOW_ORGANIZATION_ID ?? "";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
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
      const json = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8")) as Record<
        string,
        unknown
      >;
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

/** Mint a fresh dashboard access JWT from Clerk session id + `__client` cookie jar. */
export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    clerkSessionId?: unknown;
    clerkCookie?: unknown;
    organizationId?: unknown;
    clerkBase?: unknown;
    appOrigin?: unknown;
    clerkApiVersion?: unknown;
    clerkJsVersion?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const clerkCookie = stripCookieHeaderPrefix(str(body.clerkCookie));
  const sessionIdIn = str(body.clerkSessionId);
  const sidFromCookie = clerkCookie ? extractSidFromClientCookie(clerkCookie) : null;
  const sessionIds = [...new Set([sessionIdIn, sidFromCookie ?? ""].filter((s) => s.startsWith("sess_")))];

  if (!clerkCookie || sessionIds.length === 0) {
    return NextResponse.json(
      { error: "clerkSessionId (sess_…) and clerkCookie (__client jar) required to refresh JWT" },
      { status: 400 }
    );
  }

  const clerkBase = str(body.clerkBase) || DEFAULT_CLERK_BASE;
  const appOrigin = str(body.appOrigin) || DEFAULT_APP_ORIGIN;
  const clerkApiVersion = str(body.clerkApiVersion) || DEFAULT_CLERK_API_VERSION;
  const clerkJsVersion = str(body.clerkJsVersion) || DEFAULT_CLERK_JS_VERSION;
  const organizationId = str(body.organizationId) || ENV_ORGANIZATION_ID;
  const q = clerkFapiQuery(clerkApiVersion, clerkJsVersion);
  const referers = [`${appOrigin.replace(/\/$/, "")}/`, `${clerkBase.replace(/\/$/, "")}/`];

  let lastErr = "Clerk token failed";
  let cookieJarOut = clerkCookie;

  for (const sid of sessionIds) {
    const url = `${clerkBase.replace(/\/$/, "")}/v1/client/sessions/${encodeURIComponent(sid)}/tokens?${q}`;
    for (const referer of referers) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          accept: "*/*",
          "content-type": "application/x-www-form-urlencoded",
          cookie: clerkCookie,
          origin: appOrigin.replace(/\/$/, ""),
          referer,
          "user-agent": CLERK_FAPI_UA,
        },
        body: new URLSearchParams({ organization_id: organizationId }).toString(),
      });
      const raw = await res.text();
      const setLines = getSetCookieLines(res);
      if (setLines.length) cookieJarOut = mergeCookieJar(cookieJarOut, setLines);

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        lastErr = `Clerk token (${res.status}, non-JSON)`;
        continue;
      }
      const jwt = extractClerkJwtFromJson(json);
      if (res.ok && jwt) {
        return NextResponse.json({
          jwt,
          sessionId: sid,
          cookieJar: cookieJarOut,
        });
      }
      const deep = clerkJsonErrorSummary(json);
      lastErr = deep || `Clerk token (${res.status})`;
    }
  }

  return NextResponse.json({ error: lastErr }, { status: 502 });
}
