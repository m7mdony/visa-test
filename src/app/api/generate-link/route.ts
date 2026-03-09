import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json();
  const baseUrl: string | undefined = body.baseUrl;

  const sessionApiUrl =
    process.env.SESSION_API_URL ??
    "https://face-verification-app.getlawhat.com/api/generate-liveness-session";

  try {
    const res = await fetch(sessionApiUrl, {
      method: "GET",
      headers: {
        "User-Agent": "ui-test-nextjs",
      },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Upstream error: ${res.status} ${res.statusText}` },
        { status: 502 },
      );
    }

    const data = (await res.json()) as { fullUrl?: string; [k: string]: any };

    if (!data.fullUrl || typeof data.fullUrl !== "string") {
      return NextResponse.json(
        { error: "API did not return fullUrl" },
        { status: 500 },
      );
    }

    const trimmed =
      typeof baseUrl === "string" ? baseUrl.trim() : "";

    if (!trimmed) {
      // No override provided: return upstream URL as-is
      return NextResponse.json({ fullUrl: data.fullUrl });
    }

    const normalizedBase = trimmed.replace(/\/+$/, "");
    const fullUrl = data.fullUrl.replace(
      "http://localhost:3003",
      normalizedBase,
    );

    return NextResponse.json({ fullUrl });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to generate link" },
      { status: 500 },
    );
  }
}

