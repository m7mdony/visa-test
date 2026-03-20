import { NextResponse } from "next/server";
import Redis from "ioredis";
import https from "https";
import { URL } from "url";

type SessionResponse = {
  success?: boolean;
  sessionId?: string;
  region?: string;
  credentials?: any;
  message?: string;
  [k: string]: any;
};

function generateRandomPassportNumber() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const numbers = "0123456789";
  const letter = letters[Math.floor(Math.random() * letters.length)];
  const randomNumbers = Array.from({ length: 7 }, () =>
    numbers[Math.floor(Math.random() * numbers.length)],
  ).join("");
  return letter + randomNumbers;
}

function fetchNewSession(sessionApiUrl: string): Promise<SessionResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(sessionApiUrl);

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "GET",
      family: 4,
      timeout: 30000,
      headers: {
        "User-Agent": "ui-test-nextjs",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";

      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        reject(
          new Error(
            `HTTP ${res.statusCode}: ${res.statusMessage || "Request failed"}`,
          ),
        );
        return;
      }

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const sessionData = JSON.parse(data);
          resolve(sessionData);
        } catch (error: any) {
          reject(new Error(`Failed to parse response: ${error.message}`));
        }
      });
    });

    req.on("error", (error) => {
      reject(
        new Error(
          `Connection error: ${error.message}. This might be a network issue or the server might be unreachable.`,
        ),
      );
    });

    req.on("timeout", () => {
      req.destroy();
      reject(
        new Error(
          `Request timeout after 30000ms. The server might be slow or unreachable.`,
        ),
      );
    });

    req.setTimeout(30000);
    req.end();
  });
}

export async function POST(request: Request) {
  const body = await request.json();
  const redisUrl: string | undefined = body.redisUrl || process.env.REDIS_URL;
  const sessionApiUrl: string | undefined =
    body.sessionApiUrl || process.env.SESSION_API_URL;
  const streamSuffix: string | undefined = body.streamSuffix;
  const videoUrls: string[] = body.videoUrls || [];
  const repetitions: number = body.repetitions || 1;
  const isFirstVerification: boolean = !!body.isFirstVerification;
  const timeoutSecondsRaw: unknown = body.timeoutSeconds;
  const timeoutSeconds =
    typeof timeoutSecondsRaw === "number" && Number.isFinite(timeoutSecondsRaw) && timeoutSecondsRaw > 0
      ? timeoutSecondsRaw
      : 0;

  if (!redisUrl) {
    return NextResponse.json({ error: "Redis URL is required" }, { status: 400 });
  }
  if (!sessionApiUrl) {
    return NextResponse.json(
      { error: "Session API URL is required" },
      { status: 400 },
    );
  }
  if (!streamSuffix) {
    return NextResponse.json(
      { error: "Stream key suffix is required" },
      { status: 400 },
    );
  }
  if (!Array.isArray(videoUrls) || videoUrls.length === 0) {
    return NextResponse.json(
      { error: "At least one video URL is required" },
      { status: 400 },
    );
  }

  const streamKeyPrefix =
    process.env.STREAM_KEY_PREFIX ?? "vfs:identity-verification:stream:";
  const streamKey = `${streamKeyPrefix}${streamSuffix}`;

  const expandedVideoUrls = Array.from({ length: repetitions }, () => videoUrls)
    .flat()
    .slice(0); // copy

  const randomizeOrder: boolean = !!body.randomizeOrder;
  if (randomizeOrder && expandedVideoUrls.length > 1) {
    for (let i = expandedVideoUrls.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = expandedVideoUrls[i];
      expandedVideoUrls[i] = expandedVideoUrls[j];
      expandedVideoUrls[j] = tmp;
    }
  }

  const redis = new Redis(redisUrl);

  const results: Array<{
    success: boolean;
    sessionId?: string;
    messageId?: string;
    videoUrl: string;
    error?: string;
  }> = [];

  for (let index = 0; index < expandedVideoUrls.length; index++) {
    const videoUrl = expandedVideoUrls[index];
    if (index > 0 && timeoutSeconds > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, timeoutSeconds * 1000),
      );
    }
    try {
      const sessionData = await fetchNewSession(sessionApiUrl);
      if (!sessionData.success) {
        throw new Error(
          `Failed to create session for video ${index + 1}: ${
            sessionData.message || "unknown error"
          }`,
        );
      }

      if (!sessionData.sessionId || !sessionData.region) {
        throw new Error("Session response missing sessionId or region");
      }

      const message = {
        id: sessionData.sessionId,
        sessionId: sessionData.sessionId,
        region: sessionData.region,
        credentials: sessionData.credentials,
        videoUrl,
        passportNumber: generateRandomPassportNumber(),
        isFirstVerification,
        deviceProperties: {
          userAgent:
            "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36",
          width: 1100,
          height: 982,
        },
      };

      const messageId = await redis.xadd(
        streamKey,
        "*",
        "body",
        JSON.stringify(message),
      );

      results.push({
        success: true,
        sessionId: sessionData.sessionId!,
        messageId,
        videoUrl,
      });
    } catch (error: any) {
      results.push({
        success: false,
        error: error.message || String(error),
        videoUrl,
      });
    }
  }

  await redis.quit();

  return NextResponse.json({ results });
}

