import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import Redis from "ioredis";
import { randomUUID } from "crypto";

/** Same host/stream as `azure-liveness-automation/parrallel-test-session.js`. */
const REDIS_URL =
  process.env.EXPOSURE_CHECK_REDIS_URL ??
  process.env.REDIS_URL ??
  "redis://:v9qsTSb7FwKk@167.235.169.61:30379";
const STAGING_STREAM_KEY = "azure:identity-verification:stream:staging";

const AZURE_CREDENTIALS =
  "eyJhbGciOiJFUzI1NiIsImtpZCI6ImtleTEiLCJ0eXAiOiJKV1QifQ.eyJyZWdpb24iOiJlYXN0dXMiLCJzdWJzY3JpcHRpb24taWQiOiI3YTI1NjEwZGVhZjk0M2U2YmZlMmVlNjQyN2I3MDFlYiIsInByb2R1Y3QtaWQiOiJGYWNlLlMwIiwiYWxsb3dlZC1wYXRocyI6Ilt7XCJwYXRoXCI6XCJmYWNlL3YxLjIvc2Vzc2lvbi9zdGFydFwiLFwibWV0aG9kXCI6XCJQT1NUXCIsXCJxdW90YVwiOjEsXCJjYWxsUmF0ZVJlbmV3YWxQZXJpb2RcIjo2MCxcImNhbGxSYXRlTGltaXRcIjoxfSx7XCJwYXRoXCI6XCJmYWNlL3YxLjIvc2Vzc2lvbi9hdHRlbXB0L2VuZFwiLFwibWV0aG9kXCI6XCJQT1NUXCIsXCJxdW90YVwiOjMsXCJjYWxsUmF0ZVJlbmV3YWxQZXJpb2RcIjo1LFwiY2FsbFJhdGVMaW1pdFwiOjF9LHtcInBhdGhcIjpcImZhY2UvdjEuMi9kZXRlY3RMaXZlbmVzc1dpdGhWZXJpZnkvc2luZ2xlTW9kYWxcIixcIm1ldGhvZFwiOlwicG9zdFwiLFwicXVvdGFcIjozLFwiY2FsbFJhdGVSZW5ld2FsUGVyaW9kXCI6NSxcImNhbGxSYXRlTGltaXRcIjoxfV0iLCJhenVyZS1yZXNvdXJjZS1pZCI6Ii9zdWJzY3JpcHRpb25zLzU3ZGU1M2Q3LTViN2YtNDQwNi1iODY5LTU1ZTJhZDgzMWY5Mi9yZXNvdXJjZUdyb3Vwcy92ZnMtaWRwL3Byb3ZpZGVycy9NaWNyb3NvZnQuQ29nbml0aXZlU2VydmljZXMvYWNjb3VudHMvdmZzLWxpdmVuZXNzLTAxIiwic2lkIjoiOGNhYjA5MTQtOGZkNy00MGEwLTk3NDUtN2YyYzA4OTQyYmRkIiwiZmFjZSI6IntcImVuZHBvaW50XCI6XCJodHRwczovL3Zmcy1saXZlbmVzcy0wMS5jb2duaXRpdmVzZXJ2aWNlcy5henVyZS5jb21cIixcInNlc3Npb25UeXBlXCI6XCJMaXZlbmVzc1dpdGhWZXJpZnlcIixcImNsaWVudENsYWltc1wiOntcInZlcmlmeUltYWdlUHJvdmlkZWRcIjp0cnVlLFwibGl2ZW5lc3NPcGVyYXRpb25Nb2RlXCI6XCJQYXNzaXZlQWN0aXZlXCIsXCJkY2ljXCI6ZmFsc2UsXCJjc2ZjXCI6XCIxOzEwOzIwMjUwOFwifX0iLCJhdWQiOiJ1cm46bXMuZmFjZVNlc3Npb25Ub2tlbiIsImV4cCI6MTc3NjA3NzU3MiwiaWF0IjoxNzc2MDc3MjcyLCJpc3MiOiJ1cm46bXMuY29nbml0aXZlc2VydmljZXMifQ.QLAe6oj7580ztAE7po1kADqU72ydL5PNQSFIPNvbYhVm8TdOcAwq05apAV7XzZExwh9XwEInKw-1NkZ5l_uCdg";

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { videoUrl?: string; passportNumber?: string; passportURL?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const videoUrl = typeof body.videoUrl === "string" ? body.videoUrl.trim() : "";
  const passportNumber = typeof body.passportNumber === "string" ? body.passportNumber.trim() : "";
  if (!videoUrl) {
    return NextResponse.json({ error: "videoUrl is required" }, { status: 400 });
  }
  if (!passportNumber) {
    return NextResponse.json({ error: "passportNumber is required" }, { status: 400 });
  }

  const jobId = randomUUID();
  const sessionId = randomUUID();
  const message = {
    id: jobId,
    sessionId,
    useRealToken: true,
    firstTry: true,
    isVerificationJob: false,
    isTesting: true,
    credentials: AZURE_CREDENTIALS,
    videoUrl,
    passportNumber,
    passportURL: typeof body.passportURL === "string" ? body.passportURL.trim() : "",
  };

  const redis = new Redis(REDIS_URL);
  try {
    const messageId = await redis.xadd(STAGING_STREAM_KEY, "*", "body", JSON.stringify(message));
    return NextResponse.json({
      success: true,
      streamKey: STAGING_STREAM_KEY,
      messageId,
      jobId,
      sessionId,
      videoUrl,
      passportNumber,
      resultPollKeys: [jobId, sessionId],
    });
  } finally {
    await redis.quit();
  }
}
