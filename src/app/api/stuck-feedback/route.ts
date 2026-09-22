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
import { buildStuckFeedbackReport } from "@/lib/stuckFeedback";

export const maxDuration = 300;

const AZURE_LIVENESS_BOT_APP_PROD = "azure-liveness-bot";
const AZURE_LIVENESS_BOT_APP_STAGING = "azure-liveness-automation-staging";
const LOKI_STAGING_NAMESPACE = "staging";

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
  const queryBody = {
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
  };
  const { logs } = await fetchLokiQueryWithRetry({
    url: `${base}/api/ds/query?ds_type=loki&requestId=${encodeURIComponent(requestId)}`,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; StuckFeedback/1.0)",
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      Origin: base,
      "x-datasource-uid": LOKI_DATASOURCE_UID,
      "x-grafana-org-id": "1",
      "x-plugin-id": "loki",
      "x-query-group-id": "stuck-feedback",
    },
    body: queryBody,
    requestId,
  });
  return logs;
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isGrafanaConfigured()) {
    return NextResponse.json({ error: "GRAFANA_URL not configured" }, { status: 500 });
  }

  let body: { from?: unknown; to?: unknown; deploymentEnv?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const fromVal = parseTime(body.from);
  const toVal = parseTime(body.to);
  if (fromVal == null || toVal == null || fromVal >= toVal) {
    return NextResponse.json({ error: "From must be before To." }, { status: 400 });
  }

  const deploymentEnv = body.deploymentEnv === "staging" ? "staging" : "prod";
  const solverApp =
    deploymentEnv === "staging" ? AZURE_LIVENESS_BOT_APP_STAGING : AZURE_LIVENESS_BOT_APP_PROD;
  const lokiNamespace = deploymentEnv === "staging" ? LOKI_STAGING_NAMESPACE : null;

  const base = getGrafanaBase();
  const cookieHeader = await loginGrafanaCookie(base);
  if (!cookieHeader) {
    return NextResponse.json({ error: "Grafana login failed (no session cookie)" }, { status: 502 });
  }

  const stuckLogs = await queryLokiLogs({
    base,
    cookieHeader,
    from: fromVal,
    to: toVal,
    app: solverApp,
    lokiNamespace,
    query: "STUCK-FEEDBACK",
    requestId: "stuck_feedback_stuck",
  });

  const report = buildStuckFeedbackReport({ stuckLogs, enrichmentLogs: [] });

  return NextResponse.json({
    from: fromVal,
    to: toVal,
    deploymentEnv,
    solverApp,
    totals: {
      stuckQueryLines: stuckLogs.length,
      episodeCount: report.episodes.length,
      distinctClips: Object.keys(report.clipCounts).length,
      withPassport: report.episodes.filter((e) => e.passportNumber).length,
    },
    clipCounts: report.clipCounts,
    episodes: report.episodes,
  });
}
