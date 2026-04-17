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
import { CLERK_BOOTSTRAP_COOKIE_FALLBACK } from "@/config/visaflowClerkDefaults";

const ENV_BOOTSTRAP_COOKIE = process.env.VISAFLOW_CLERK_BOOTSTRAP_COOKIE ?? "";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Clerk returns `supported_first_factors` on `response` and/or `client.sign_in`. */
function findEmailCodeFirstFactor(json: unknown): { email_address_id: string } | null {
  const o = json as Record<string, unknown>;
  const factors: unknown[] = [];
  const response = o.response as Record<string, unknown> | undefined;
  const fromResponse = response?.supported_first_factors;
  if (Array.isArray(fromResponse)) factors.push(...fromResponse);
  const client = o.client as Record<string, unknown> | undefined;
  const signIn = client?.sign_in as Record<string, unknown> | undefined;
  const fromClient = signIn?.supported_first_factors;
  if (Array.isArray(fromClient)) factors.push(...fromClient);
  for (const item of factors) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    if (
      f.strategy === "email_code" &&
      typeof f.email_address_id === "string" &&
      f.email_address_id.startsWith("idn_")
    ) {
      return { email_address_id: f.email_address_id };
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    email?: unknown;
    bootstrapCookie?: unknown;
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

  const email = str(body.email);
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  const bootstrap = stripCookieHeaderPrefix(
    str(body.bootstrapCookie) || ENV_BOOTSTRAP_COOKIE || CLERK_BOOTSTRAP_COOKIE_FALLBACK,
  );
  if (!bootstrap) {
    return NextResponse.json({ error: "Bootstrap cookie missing (server misconfiguration)." }, { status: 500 });
  }

  const clerkBase = str(body.clerkBase) || DEFAULT_CLERK_BASE;
  const appOrigin = str(body.appOrigin) || DEFAULT_APP_ORIGIN;
  const clerkApiVersion = str(body.clerkApiVersion) || DEFAULT_CLERK_API_VERSION;
  const clerkJsVersion = str(body.clerkJsVersion) || DEFAULT_CLERK_JS_VERSION;

  const q = clerkFapiQuery(clerkApiVersion, clerkJsVersion);
  const url = `${clerkBase.replace(/\/$/, "")}/v1/client/sign_ins?${q}`;
  const origin = appOrigin.replace(/\/$/, "");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded",
      cookie: bootstrap,
      origin,
      referer: `${origin}/`,
      "user-agent": CLERK_FAPI_UA,
    },
    body: new URLSearchParams({ locale: "en-US", identifier: email }).toString(),
  });

  const raw = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return NextResponse.json(
      {
        error: `Clerk sign_ins returned non-JSON (HTTP ${res.status})`,
        clerkHttpStatus: res.status,
        clerkDebug: raw.slice(0, 1200).replace(/\s+/g, " "),
      },
      { status: 502 },
    );
  }

  const o = json as Record<string, unknown>;
  const response = o.response as Record<string, unknown> | undefined;
  const signInAttemptId = typeof response?.id === "string" ? response.id : null;
  const clerkSignInStatus = typeof response?.status === "string" ? response.status : null;

  if (!res.ok) {
    const deep = clerkFapiDeepSummary(json);
    return NextResponse.json(
      {
        error: deep || `Clerk sign_ins HTTP ${res.status}`,
        clerkHttpStatus: res.status,
        clerkDebug: deep ? `${deep}\n\n${clerkResponseSnippet(json)}` : clerkResponseSnippet(json),
      },
      { status: res.status >= 400 && res.status < 600 ? res.status : 502 },
    );
  }

  if (!signInAttemptId || !signInAttemptId.startsWith("sia_")) {
    const detail = clerkFapiDeepSummary(json) || clerkJsonErrorSummary(json);
    return NextResponse.json(
      {
        error: detail || `Clerk sign_ins missing sign-in attempt id (HTTP ${res.status})`,
        clerkHttpStatus: res.status,
        clerkDebug: clerkResponseSnippet(json, 1400),
      },
      { status: 502 },
    );
  }

  const setLines = getSetCookieLines(res);
  let cookieJar = setLines.length ? mergeCookieJar(bootstrap, setLines) : bootstrap;

  const warning =
    clerkSignInStatus && clerkSignInStatus !== "needs_first_factor"
      ? `Clerk sign_in status is "${clerkSignInStatus}" (expected needs_first_factor). Email may not be sent — check Clerk dashboard / spam / CAPTCHA.`
      : null;

  const emailFactor = findEmailCodeFirstFactor(json);
  if (!emailFactor) {
    return NextResponse.json(
      {
        error:
          "Clerk did not return an email_code first factor (email_address_id). Cannot call prepare_first_factor to send the OTP.",
        clerkHttpStatus: res.status,
        clerkDebug: clerkResponseSnippet(json, 1600),
        signInAttemptId,
        cookieJar,
      },
      { status: 422 },
    );
  }

  const prepareUrl = `${clerkBase.replace(/\/$/, "")}/v1/client/sign_ins/${encodeURIComponent(signInAttemptId)}/prepare_first_factor?${q}`;
  const prepareRes = await fetch(prepareUrl, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieJar,
      origin,
      referer: `${origin}/`,
      "user-agent": CLERK_FAPI_UA,
    },
    body: new URLSearchParams({
      email_address_id: emailFactor.email_address_id,
      strategy: "email_code",
    }).toString(),
  });

  const prepareRaw = await prepareRes.text();
  let prepareJson: unknown;
  try {
    prepareJson = JSON.parse(prepareRaw) as unknown;
  } catch {
    return NextResponse.json(
      {
        error: "Clerk prepare_first_factor returned non-JSON",
        clerkHttpStatus: prepareRes.status,
        clerkDebug: prepareRaw.slice(0, 1200).replace(/\s+/g, " "),
        signInAttemptId,
        cookieJar,
      },
      { status: 502 },
    );
  }

  if (!prepareRes.ok) {
    const deep = clerkFapiDeepSummary(prepareJson);
    return NextResponse.json(
      {
        error: deep || `Clerk prepare_first_factor HTTP ${prepareRes.status}`,
        clerkHttpStatus: prepareRes.status,
        clerkDebug: deep ? `${deep}\n\n${clerkResponseSnippet(prepareJson)}` : clerkResponseSnippet(prepareJson),
        signInAttemptId,
        cookieJar,
      },
      { status: prepareRes.status >= 400 && prepareRes.status < 600 ? prepareRes.status : 502 },
    );
  }

  const prepareSetLines = getSetCookieLines(prepareRes);
  if (prepareSetLines.length) {
    cookieJar = mergeCookieJar(cookieJar, prepareSetLines);
  }

  return NextResponse.json({
    signInAttemptId,
    cookieJar,
    clerkSignInStatus,
    warning,
    prepareFirstFactorOk: true,
  });
}
