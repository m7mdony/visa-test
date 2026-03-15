import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

const GRAFANA_URL = process.env.GRAFANA_URL ?? "";
const GRAFANA_USER = process.env.GRAFANA_USER ?? "admin";
const GRAFANA_PASSWORD = process.env.GRAFANA_PASSWORD ?? "";

function getCookieHeader(setCookie: string[]): string {
  return setCookie
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!GRAFANA_URL) {
    return NextResponse.json(
      { error: "GRAFANA_URL not configured" },
      { status: 500 }
    );
  }

  let body: { count?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const count = Math.min(Math.max(1, Math.floor(Number(body.count) || 1)), 100);
  const base = GRAFANA_URL.replace(/\/$/, "");
  const loginUrl = `${base}/login`;

  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (compatible; Grafana-Logs-UI/1.0)",
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Referer": loginUrl,
  };

  const cookieHeaders: string[] = [];

  for (let i = 0; i < count; i++) {
    const loginRes = await fetch(loginUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        user: GRAFANA_USER,
        password: GRAFANA_PASSWORD,
      }),
      redirect: "manual",
      // @ts-expect-error
      rejectUnauthorized: false,
    });

    let setCookie: string[] = [];
    if (typeof loginRes.headers.getSetCookie === "function") {
      setCookie = loginRes.headers.getSetCookie();
    } else {
      const sc = loginRes.headers.get("set-cookie");
      if (sc) setCookie = [sc];
    }
    const cookieHeader = getCookieHeader(setCookie);
    if (cookieHeader) {
      cookieHeaders.push(cookieHeader);
    }
  }

  return NextResponse.json({ cookies: cookieHeaders });
}
