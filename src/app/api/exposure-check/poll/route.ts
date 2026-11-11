import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import Redis from "ioredis";
import { precheckVerdictFromFailureReason } from "@/lib/exposureCheckCohort";

const REDIS_URL =
  process.env.EXPOSURE_CHECK_REDIS_URL ??
  process.env.REDIS_URL ??
  "redis://:v9qsTSb7FwKk@167.235.169.61:30379";
const LIVENESS_RESULT_KEY_PREFIX = "vfs:liveness:result:";

type ResultPayload = {
  success?: boolean;
  failureReason?: string | null;
  messageId?: string;
  timestamp?: number;
};

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { resultPollKeys?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const keysRaw = body.resultPollKeys;
  const keys =
    Array.isArray(keysRaw) && keysRaw.length > 0
      ? keysRaw.filter((k): k is string => typeof k === "string" && k.trim().length > 0)
      : [];
  if (keys.length === 0) {
    return NextResponse.json({ error: "resultPollKeys required" }, { status: 400 });
  }

  const redis = new Redis(REDIS_URL);
  try {
    for (const key of keys) {
      const raw = await redis.get(`${LIVENESS_RESULT_KEY_PREFIX}${key}`);
      if (!raw) continue;
      let parsed: ResultPayload;
      try {
        parsed = JSON.parse(raw) as ResultPayload;
      } catch {
        continue;
      }
      const failureReason =
        typeof parsed.failureReason === "string" ? parsed.failureReason : null;
      const precheck = precheckVerdictFromFailureReason(failureReason);
      return NextResponse.json({
        ready: true,
        resultKey: key,
        success: !!parsed.success,
        failureReason,
        precheckVerdict: precheck,
        timestamp: parsed.timestamp ?? null,
      });
    }
    return NextResponse.json({ ready: false });
  } finally {
    await redis.quit();
  }
}
