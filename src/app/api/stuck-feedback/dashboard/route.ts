import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  buildLokiLineFilterExpr,
  fetchLokiQueryWithRetry,
  getGrafanaBase,
  isGrafanaConfigured,
  loginGrafanaCookie,
  LOKI_DATASOURCE_UID,
  LOKI_MAX_LINES_PER_QUERY,
  type LogEntry,
} from "@/lib/grafanaLoki";
import {
  buildJobMetaMap,
  episodeKey,
  extractPassportFromJobId,
  resolvePassportForJob,
} from "@/lib/stuckFeedback";
import { fetchDashboardMediaForPassports } from "@/lib/visaflowDashboardMediaFetch";
import { findGestureClipUrl, lookupByPassportKey } from "@/lib/visaflowDashboardPassports";

export const maxDuration = 300;

const AZURE_LIVENESS_BOT_APP_PROD = "azure-liveness-bot";
const AZURE_LIVENESS_BOT_APP_STAGING = "azure-liveness-automation-staging";
const LOKI_STAGING_NAMESPACE = "staging";
const LOOKBACK_MS = 2 * 60 * 60 * 1000;
const LOOKAHEAD_MS = 30 * 60 * 1000;

function lokiLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

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

async function queryLokiLogs(params: {
  base: string;
  cookieHeader: string;
  from: number;
  to: number;
  app: string;
  lokiNamespace?: string | null;
  query: string | string[];
  requestId: string;
}): Promise<LogEntry[]> {
  const { base, cookieHeader, from, to, app, lokiNamespace, query, requestId } = params;
  const appEsc = lokiLabelValue(app);
  const selector =
    lokiNamespace && lokiNamespace.trim().length > 0
      ? `{namespace="${lokiLabelValue(lokiNamespace.trim())}", app="${appEsc}"}`
      : `{app="${appEsc}"}`;
  const expr = buildLokiLineFilterExpr(selector, query);
  const { logs } = await fetchLokiQueryWithRetry({
    url: `${base}/api/ds/query?ds_type=loki&requestId=${encodeURIComponent(requestId)}`,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; StuckFeedbackDashboard/1.0)",
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      Origin: base,
      "x-datasource-uid": LOKI_DATASOURCE_UID,
      "x-grafana-org-id": "1",
      "x-plugin-id": "loki",
      "x-query-group-id": "stuck-feedback-dashboard",
    },
    body: {
      queries: [
        {
          expr,
          queryType: "range",
          refId: "logs",
          maxLines: LOKI_MAX_LINES_PER_QUERY,
          direction: "backward",
          datasource: { type: "loki", uid: LOKI_DATASOURCE_UID },
          datasourceId: 1,
          intervalMs: to - from,
        },
      ],
      from: String(from),
      to: String(to),
    },
    requestId,
  });
  return logs;
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

  const fromVal = parseTime(body.from);
  const toVal = parseTime(body.to);
  const startedTimes = episodes
    .map((e) => Date.parse(e.startedAt))
    .filter((t) => Number.isFinite(t));
  const lokiFrom =
    fromVal != null
      ? Math.max(0, fromVal - LOOKBACK_MS)
      : startedTimes.length
        ? Math.max(0, Math.min(...startedTimes) - LOOKBACK_MS)
        : Date.now() - LOOKBACK_MS;
  const lokiTo =
    toVal != null
      ? toVal + LOOKAHEAD_MS
      : startedTimes.length
        ? Math.max(...startedTimes) + LOOKAHEAD_MS
        : Date.now();

  const deploymentEnv = body.deploymentEnv === "staging" ? "staging" : "prod";
  const solverApp =
    deploymentEnv === "staging" ? AZURE_LIVENESS_BOT_APP_STAGING : AZURE_LIVENESS_BOT_APP_PROD;
  const lokiNamespace = deploymentEnv === "staging" ? LOKI_STAGING_NAMESPACE : null;

  let metaByPrefix = new Map<string, { passportNumber: string | null; videoUrl: string | null }>();
  if (isGrafanaConfigured()) {
    const base = getGrafanaBase();
    const cookieHeader = await loginGrafanaCookie(base);
    if (cookieHeader) {
      const [payloadLogs, solvingLogs, jobReceivedLogs] = await Promise.all([
        queryLokiLogs({
          base,
          cookieHeader,
          from: lokiFrom,
          to: lokiTo,
          app: solverApp,
          lokiNamespace,
          query: "[REDIS][PAYLOAD]",
          requestId: "stuck_dash_payload",
        }),
        queryLokiLogs({
          base,
          cookieHeader,
          from: lokiFrom,
          to: lokiTo,
          app: solverApp,
          lokiNamespace,
          query: "Solving face",
          requestId: "stuck_dash_solving",
        }),
        queryLokiLogs({
          base,
          cookieHeader,
          from: lokiFrom,
          to: lokiTo,
          app: solverApp,
          lokiNamespace,
          query: "[REDIS] Job received",
          requestId: "stuck_dash_job_received",
        }),
      ]);
      metaByPrefix = buildJobMetaMap([...payloadLogs, ...solvingLogs, ...jobReceivedLogs]);
    }
  }

  const resolvedPassportByKey = new Map<string, string>();
  for (const ep of episodes) {
    const key = episodeKey(ep.jobId, ep.clip, ep.startedAt);
    const passport = resolvePassportForJob(
      ep.jobId,
      ep.passportNumber ?? extractPassportFromJobId(ep.jobId),
      metaByPrefix,
    );
    if (passport) resolvedPassportByKey.set(key, passport);
  }

  const uniquePassports = [...new Set(resolvedPassportByKey.values())];
  const dash = await fetchDashboardMediaForPassports({
    body: body as Record<string, unknown>,
    passportNumbers: uniquePassports,
  });

  const byEpisode: Record<string, StuckEpisodeDashboardRow> = {};
  for (const ep of episodes) {
    const key = episodeKey(ep.jobId, ep.clip, ep.startedAt);
    const passport = resolvedPassportByKey.get(key) ?? null;
    if (!passport) {
      byEpisode[key] = {
        key,
        passportNumber: null,
        applicantId: null,
        passportImageUrl: null,
        gestureClipUrl: null,
        error: "No passport (JOB_ID or solver payload)",
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

  return NextResponse.json({
    byEpisode,
    byPassport: dash.byPassport,
    enrichedPassports: uniquePassports.length,
    lokiFrom,
    lokiTo,
    ...(dash.error ? { warning: dash.error } : {}),
    ...(dash.refreshedBearerJwt ? { refreshedBearerJwt: dash.refreshedBearerJwt } : {}),
  });
}
