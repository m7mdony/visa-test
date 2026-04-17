import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  CLERK_FAPI_UA,
  DEFAULT_APP_ORIGIN,
  DEFAULT_CLERK_API_VERSION,
  DEFAULT_CLERK_BASE,
  DEFAULT_CLERK_JS_VERSION,
  clerkFapiDeepSummary,
  clerkFapiQuery,
  clerkJsonErrorSummary,
  clerkResponseSnippet,
  getSetCookieLines,
  mergeCookieJar,
  stripCookieHeaderPrefix,
} from "@/lib/clerkVisaflowFapi";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    signInAttemptId?: unknown;
    code?: unknown;
    cookieJar?: unknown;
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

  const signInAttemptId = str(body.signInAttemptId);
  const code = str(body.code).replace(/\s+/g, "");
  const cookieJarIn = stripCookieHeaderPrefix(str(body.cookieJar));

  if (!signInAttemptId.startsWith("sia_")) {
    return NextResponse.json({ error: "signInAttemptId (sia_…) required — run Send code first" }, { status: 400 });
  }
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "Email code must be 6 digits" }, { status: 400 });
  }
  if (!cookieJarIn) {
    return NextResponse.json({ error: "cookieJar from the Send code step is required" }, { status: 400 });
  }

  const clerkBase = str(body.clerkBase) || DEFAULT_CLERK_BASE;
  const appOrigin = str(body.appOrigin) || DEFAULT_APP_ORIGIN;
  const clerkApiVersion = str(body.clerkApiVersion) || DEFAULT_CLERK_API_VERSION;
  const clerkJsVersion = str(body.clerkJsVersion) || DEFAULT_CLERK_JS_VERSION;

  const q = clerkFapiQuery(clerkApiVersion, clerkJsVersion);
  const url = `${clerkBase.replace(/\/$/, "")}/v1/client/sign_ins/${encodeURIComponent(signInAttemptId)}/attempt_first_factor?${q}`;
  const origin = appOrigin.replace(/\/$/, "");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieJarIn,
      origin,
      referer: `${origin}/`,
      "user-agent": CLERK_FAPI_UA,
    },
    body: new URLSearchParams({ strategy: "email_code", code }).toString(),
  });

  const raw = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return NextResponse.json(
      {
        error: `Clerk attempt_first_factor non-JSON (HTTP ${res.status})`,
        clerkHttpStatus: res.status,
        clerkDebug: raw.slice(0, 1200).replace(/\s+/g, " "),
      },
      { status: 502 },
    );
  }

  if (!res.ok) {
    const deep = clerkFapiDeepSummary(json);
    return NextResponse.json(
      {
        error: deep || `Clerk attempt_first_factor HTTP ${res.status}`,
        clerkHttpStatus: res.status,
        clerkDebug: deep ? `${deep}\n\n${clerkResponseSnippet(json)}` : clerkResponseSnippet(json),
      },
      { status: res.status >= 400 && res.status < 600 ? res.status : 502 },
    );
  }

  const o = json as Record<string, unknown>;
  const client = o.client as Record<string, unknown> | undefined;
  const sessions = client?.sessions;
  const s0 =
    Array.isArray(sessions) && sessions[0] && typeof sessions[0] === "object"
      ? (sessions[0] as Record<string, unknown>)
      : undefined;
  const lastActive = s0?.last_active_token as Record<string, unknown> | undefined;
  const jwt = typeof lastActive?.jwt === "string" ? lastActive.jwt : null;

  const response = o.response as Record<string, unknown> | undefined;
  const sessionId =
    (typeof response?.created_session_id === "string" && response.created_session_id) ||
    (typeof client?.last_active_session_id === "string" && client.last_active_session_id) ||
    null;

  if (!jwt || !sessionId) {
    const deep = clerkFapiDeepSummary(json) || clerkJsonErrorSummary(json);
    const respSt = typeof response?.status === "string" ? response.status : "?";
    return NextResponse.json(
      {
        error:
          deep ||
          `Sign-in not complete (response.status=${respSt}). Wrong code, expired attempt, or cookie jar out of sync — use Send code again.`,
        clerkHttpStatus: res.status,
        clerkDebug: `${deep ? `${deep}\n\n` : ""}${clerkResponseSnippet(json, 1400)}`,
        clerkSignInStatus: respSt,
      },
      { status: 422 },
    );
  }

  const setLines = getSetCookieLines(res);
  const cookieJar = setLines.length ? mergeCookieJar(cookieJarIn, setLines) : cookieJarIn;

  return NextResponse.json({
    jwt,
    sessionId,
    cookieJar,
  });
}
