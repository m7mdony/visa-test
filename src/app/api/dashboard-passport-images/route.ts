import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { fetchDashboardMediaForPassports } from "@/lib/visaflowDashboardMediaFetch";

export const maxDuration = 300;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawList = body.passportNumbers;
  if (!Array.isArray(rawList) || rawList.length === 0) {
    return NextResponse.json({ error: "passportNumbers must be a non-empty array" }, { status: 400 });
  }
  const passportNumbers = [...new Set(rawList.map((x) => String(x ?? "").trim()).filter(Boolean))].slice(0, 80);

  const bearerJwtRaw = str(body.bearerJwt);
  const hasBearer = Boolean(bearerJwtRaw && bearerJwtRaw.split(".").length >= 2);
  const sessionId = str(body.clerkSessionId);
  const clerkCookie = str(body.clerkCookie);
  if (!hasBearer && (!sessionId.startsWith("sess_") || !clerkCookie)) {
    return NextResponse.json(
      {
        error:
          "Use email OTP sign-in (stores JWT) or paste Clerk session id + cookie / env VISAFLOW_CLERK_*.",
      },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await fetchDashboardMediaForPassports({
      body,
      passportNumbers,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg, byPassport: {} }, { status: 502 });
  }

  if (result.error && Object.keys(result.byPassport).length === 0) {
    return NextResponse.json({
      error: result.error,
      byPassport: {},
      clientsApplicantsScanned: result.clientsApplicantsScanned ?? 0,
      clientsCount: result.clientsCount ?? 0,
      debug: result.debug,
    });
  }

  return NextResponse.json({
    byPassport: result.byPassport,
    clientsApplicantsScanned: result.clientsApplicantsScanned,
    clientsCount: result.clientsCount,
    ...(result.refreshedBearerJwt ? { refreshedBearerJwt: result.refreshedBearerJwt } : {}),
    ...(result.error ? { warning: result.error } : {}),
    debug: result.debug,
  });
}
