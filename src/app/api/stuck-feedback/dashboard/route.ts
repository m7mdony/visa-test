import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  episodeKey,
  extractPassportFromJobId,
} from "@/lib/stuckFeedback";
import { fetchDashboardMediaForPassports } from "@/lib/visaflowDashboardMediaFetch";
import { findGestureClipUrl, lookupByPassportKey } from "@/lib/visaflowDashboardPassports";

export const maxDuration = 300;

function parseTime(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== "") return n;
    const d = Date.parse(v);
    return Number.isFinite(d) ? d : null;
  }
  return null;
}

export type StuckEpisodeDashboardRow = {
  key: string;
  passportNumber: string | null;
  applicantId: string | null;
  passportImageUrl: string | null;
  gestureClipUrl: string | null;
  error?: string;
};

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    from?: unknown;
    to?: unknown;
    deploymentEnv?: string;
    episodes?: unknown;
    bearerJwt?: unknown;
    clerkSessionId?: unknown;
    clerkCookie?: unknown;
    organizationId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const episodesRaw = body.episodes;
  if (!Array.isArray(episodesRaw) || episodesRaw.length === 0) {
    return NextResponse.json({ error: "episodes must be a non-empty array" }, { status: 400 });
  }

  const episodes = episodesRaw
    .map((e) => {
      const o = e as Record<string, unknown>;
      const jobId = typeof o.jobId === "string" ? o.jobId.trim() : "";
      const clip = typeof o.clip === "string" ? o.clip.trim() : "";
      const startedAt = typeof o.startedAt === "string" ? o.startedAt.trim() : "";
      const passportNumber =
        typeof o.passportNumber === "string" && o.passportNumber.trim()
          ? o.passportNumber.trim()
          : null;
      if (!jobId || !clip || !startedAt) return null;
      return { jobId, clip, startedAt, passportNumber };
    })
    .filter(Boolean) as Array<{
    jobId: string;
    clip: string;
    startedAt: string;
    passportNumber: string | null;
  }>;

  const uniquePassports = [
    ...new Set(
      episodes
        .map((ep) => ep.passportNumber?.trim() || extractPassportFromJobId(ep.jobId) || "")
        .filter(Boolean),
    ),
  ];

  let dash;
  try {
    dash = await fetchDashboardMediaForPassports({
      body: body as Record<string, unknown>,
      passportNumbers: uniquePassports,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[stuck-feedback/dashboard] fetch failed", msg);
    return NextResponse.json(
      {
        error: msg.includes("timeout") || msg.includes("aborted")
          ? `Dashboard fetch timed out (try fewer episodes or retry): ${msg}`
          : msg,
        byEpisode: {},
        debug: { passportsResolved: uniquePassports, fetchError: msg },
      },
      { status: 504 },
    );
  }

  const byEpisode: Record<string, StuckEpisodeDashboardRow> = {};
  for (const ep of episodes) {
    const key = episodeKey(ep.jobId, ep.clip, ep.startedAt);
    const passport = ep.passportNumber?.trim() || extractPassportFromJobId(ep.jobId) || null;

    if (!passport) {
      byEpisode[key] = {
        key,
        passportNumber: null,
        applicantId: null,
        passportImageUrl: null,
        gestureClipUrl: null,
        error: "No passport in JOB_ID",
      };
      continue;
    }

    const media = lookupByPassportKey(dash.byPassport, passport);
    if (!media) {
      byEpisode[key] = {
        key,
        passportNumber: passport,
        applicantId: null,
        passportImageUrl: null,
        gestureClipUrl: null,
        error: dash.error ?? "Dashboard lookup failed",
      };
      continue;
    }

    byEpisode[key] = {
      key,
      passportNumber: passport,
      applicantId: media.applicantId,
      passportImageUrl: media.passportImages.find((p) => p.url?.trim())?.url?.trim() ?? null,
      gestureClipUrl: findGestureClipUrl(media.gestureClips, ep.clip),
      error: media.error,
    };
  }

  if (dash.debug) {
    console.log("[stuck-feedback/dashboard]", JSON.stringify(dash.debug));
  }

  const fromVal = parseTime(body.from);
  const toVal = parseTime(body.to);

  return NextResponse.json({
    byEpisode,
    debug: {
      passportsResolved: uniquePassports,
      passportCount: uniquePassports.length,
      episodeCount: episodes.length,
      clientsApplicantsScanned: dash.clientsApplicantsScanned ?? 0,
      clientsCount: dash.clientsCount ?? 0,
      dashboardFetch: dash.debug ?? null,
    },
    from: fromVal,
    to: toVal,
    ...(dash.error ? { warning: dash.error } : {}),
    ...(dash.refreshedBearerJwt ? { refreshedBearerJwt: dash.refreshedBearerJwt } : {}),
  });
}
