import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import Redis from "ioredis";
import https from "https";
import { URL } from "url";

const REDIS_URL = "redis://:v9qsTSb7FwKk@91.98.17.61:30379";
const STREAM_KEY = "azure:identity-verification:stream:baathman2";
const SESSION_API_URL =
  "https://face-verification-app.getlawhat.com/api/generate-liveness-session?region=us-east-1";
const FIXED_CREDENTIALS =
  "eyJhbGciOiJFUzI1NiIsImtpZCI6ImtleTEiLCJ0eXAiOiJKV1QifQ.eyJyZWdpb24iOiJlYXN0dXMiLCJzdWJzY3JpcHRpb24taWQiOiI3YTI1NjEwZGVhZjk0M2U2YmZlMmVlNjQyN2I3MDFlYiIsInByb2R1Y3QtaWQiOiJGYWNlLlMwIiwiYWxsb3dlZC1wYXRocyI6Ilt7XCJwYXRoXCI6XCJmYWNlL3YxLjIvc2Vzc2lvbi9zdGFydFwiLFwibWV0aG9kXCI6XCJQT1NUXCIsXCJxdW90YVwiOjEsXCJjYWxsUmF0ZVJlbmV3YWxQZXJpb2RcIjo2MCxcImNhbGxSYXRlTGltaXRcIjoxfSx7XCJwYXRoXCI6XCJmYWNlL3YxLjIvc2Vzc2lvbi9hdHRlbXB0L2VuZFwiLFwibWV0aG9kXCI6XCJQT1NUXCIsXCJxdW90YVwiOjMsXCJjYWxsUmF0ZVJlbmV3YWxQZXJpb2RcIjo1LFwiY2FsbFJhdGVMaW1pdFwiOjF9LHtcInBhdGhcIjpcImZhY2UvdjEuMi9kZXRlY3RMaXZlbmVzc1dpdGhWZXJpZnkvc2luZ2xlTW9kYWxcIixcIm1ldGhvZFwiOlwicG9zdFwiLFwicXVvdGFcIjozLFwiY2FsbFJhdGVSZW5ld2FsUGVyaW9kXCI6NSxcImNhbGxSYXRlTGltaXRcIjoxfV0iLCJhenVyZS1yZXNvdXJjZS1pZCI6Ii9zdWJzY3JpcHRpb25zLzU3ZGU1M2Q3LTViN2YtNDQwNi1iODY5LTU1ZTJhZDgzMWY5Mi9yZXNvdXJjZUdyb3Vwcy92ZnMtaWRwL3Byb3ZpZGVycy9NaWNyb3NvZnQuQ29nbml0aXZlU2VydmljZXMvYWNjb3VudHMvdmZzLWxpdmVuZXNzLTAxIiwic2lkIjoiOTllYjVhYmItMmMyNi00ZDFkLWJkNzMtYjM4MzFjZGY4OGRlIiwiZmFjZSI6IntcImVuZHBvaW50XCI6XCJodHRwczovL3Zmcy1saXZlbmVzcy0wMS5jb2duaXRpdmVzZXJ2aWNlcy5henVyZS5jb21cIixcInNlc3Npb25UeXBlXCI6XCJMaXZlbmVzc1dpdGhWZXJpZnlcIixcImNsaWVudENsYWltc1wiOntcInZlcmlmeUltYWdlUHJvdmlkZWRcIjp0cnVlLFwibGl2ZW5lc3NPcGVyYXRpb25Nb2RlXCI6XCJQYXNzaXZlQWN0aXZlXCIsXCJkY2ljXCI6ZmFsc2UsXCJjc2ZjXCI6XCIxOzEwOzIwMjUwOFwifX0iLCJhdWQiOiJ1cm46bXMuZmFjZVNlc3Npb25Ub2tlbiIsImV4cCI6MTc3NDk3ODA5NCwiaWF0IjoxNzc0OTc3Nzk0LCJpc3MiOiJ1cm46bXMuY29nbml0aXZlc2VydmljZXMifQ.drzswIrfQpHwL9BHRSbti_hG0Xaz9XknNTmrzDvjuQ6bKZsl8h1_aBQ5Ate_IbkCzDu9OW3eq2k213lIRmwi6Q";

type SessionResponse = {
  success?: boolean;
  sessionId?: string;
  region?: string;
  message?: string;
};

function generateRandomPassportNumber() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const numbers = "0123456789";
  const letter = letters[Math.floor(Math.random() * letters.length)];
  const randomNumbers = Array.from({ length: 7 }, () => numbers[Math.floor(Math.random() * numbers.length)]).join("");
  return letter + randomNumbers;
}

function fetchNewSession(): Promise<SessionResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(SESSION_API_URL);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "GET",
        family: 4,
        timeout: 30000,
        headers: { "User-Agent": "ui-test-nextjs-approved-videos" },
      },
      (res) => {
        let data = "";
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || "Request failed"}`));
          return;
        }
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data) as SessionResponse;
            resolve(parsed);
          } catch {
            reject(new Error("Failed to parse session response"));
          }
        });
      },
    );
    req.on("error", (error) => reject(new Error(`Connection error: ${error.message}`)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout after 30000ms"));
    });
    req.setTimeout(30000);
    req.end();
  });
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { videoUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const videoUrl = typeof body.videoUrl === "string" ? body.videoUrl.trim() : "";
  if (!videoUrl) {
    return NextResponse.json({ error: "videoUrl is required" }, { status: 400 });
  }

  const sessionData = await fetchNewSession();
  if (!sessionData.success || !sessionData.sessionId || !sessionData.region) {
    return NextResponse.json(
      { error: `Failed to create session: ${sessionData.message || "unknown error"}` },
      { status: 502 },
    );
  }

  const message = {
    sessionId: sessionData.sessionId,
    region: sessionData.region,
    useRealToken: false,
    credentials: FIXED_CREDENTIALS,
    videoUrl,
    passportNumber: generateRandomPassportNumber(),
    isFirstVerification: true,
    deviceProperties: {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36",
      width: 2000,
      height: 982,
    },
  };

  const redis = new Redis(REDIS_URL);
  try {
    const messageId = await redis.xadd(STREAM_KEY, "*", "body", JSON.stringify(message));
    return NextResponse.json({
      success: true,
      streamKey: STREAM_KEY,
      messageId,
      sessionId: sessionData.sessionId,
      videoUrl,
    });
  } finally {
    await redis.quit();
  }
}

