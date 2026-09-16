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
  LOKI_QUERY_BATCH_SIZE,
  runInBatches,
  type LogEntry,
} from "@/lib/grafanaLoki";
import { buildInHouseVerVideoRows } from "@/lib/inHouseVerVideos";

export const maxDuration = 300;

const VFS_BOT_APP = "vfs-global-bot";
const AZURE_LIVENESS_BOT_APP_PROD = "azure-liveness-bot";
const AZURE_LIVENESS_BOT_APP_STAGING = "azure-liveness-automation-staging";
const LOKI_STAGING_NAMESPACE = "staging";
const LOOKBACK_MS = 6 * 60 * 60 * 1000;

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
      "User-Agent": "Mozilla/5.0 (compatible; InHouseVerVideos/1.0)",
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      Origin: base,
      "x-datasource-uid": LOKI_DATASOURCE_UID,
      "x-grafana-org-id": "1",
      "x-plugin-id": "loki",
      "x-query-group-id": "in-house-ver-videos",
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

  let body: { from?: unknown; to?: unknown; deploymentEnv?: string; target?: string };
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
  const target = typeof body.target === "string" && body.target.trim() ? body.target.trim() : VFS_BOT_APP;
  const vfsLokiNamespace = deploymentEnv === "staging" ? LOKI_STAGING_NAMESPACE : null;
  const solverApp =
    deploymentEnv === "staging" ? AZURE_LIVENESS_BOT_APP_STAGING : AZURE_LIVENESS_BOT_APP_PROD;

  const base = getGrafanaBase();
  const cookieHeader = await loginGrafanaCookie(base);
  if (!cookieHeader) {
    return NextResponse.json({ error: "Grafana login failed (no session cookie)" }, { status: 502 });
  }

  const queryFrom = Math.max(0, fromVal - LOOKBACK_MS);

  const [passedRaw, activationLogs, solverLogs] = await runInBatches(
    [
      () =>
        queryLokiLogs({
          base,
          cookieHeader,
          from: fromVal,
          to: toVal,
          app: target,
          lokiNamespace: vfsLokiNamespace,
          query: "In-house ver",
          requestId: "ihvv_vfs_passed",
        }),
      () =>
        queryLokiLogs({
          base,
          cookieHeader,
          from: queryFrom,
          to: toVal,
          app: target,
          lokiNamespace: vfsLokiNamespace,
          query: "Activated in-house identity verification token",
          requestId: "ihvv_vfs_activation",
        }),
      () =>
        queryLokiLogs({
          base,
          cookieHeader,
          from: queryFrom,
          to: toVal,
          app: solverApp,
          query: "[REDIS] Published result",
          requestId: "ihvv_solver_results",
        }),
    ],
    LOKI_QUERY_BATCH_SIZE
  );

  const rows = buildInHouseVerVideoRows({
    passedLogs: passedRaw,
    activationLogs,
    solverLogs,
  });

  return NextResponse.json({
    from: fromVal,
    to: toVal,
    queryFrom,
    target,
    deploymentEnv,
    solverApp,
    vfsLokiNamespace,
    totals: {
      vfsPassedQueryLines: passedRaw.length,
      vfsActivationQueryLines: activationLogs.length,
      solverResultQueryLines: solverLogs.length,
      passedCount: rows.length,
      withVideos: rows.filter((r) => r.solves.some((s) => s.recordedVideoUrl)).length,
      unresolved: rows.filter((r) => r.unresolvedReason).length,
    },
    rows,
  });
}
