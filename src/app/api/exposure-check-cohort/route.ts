import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  buildLokiLineFilterExpr,
  fetchLokiQueryWithRetry,
  getGrafanaBase,
  isGrafanaConfigured,
  LOKI_DATASOURCE_UID,
  LOKI_MAX_LINES_PER_QUERY,
  type LogEntry,
} from "@/lib/grafanaLoki";
import { resolveGrafanaDsQueryHeaders } from "@/lib/grafanaAuth";
import {
  dedupeExposureCohortRows,
  EXPOSURE_COHORT_LOG_SOURCES,
  parseExposureCohortRow,
  type ExposureCohortLogSource,
} from "@/lib/exposureCheckCohort";

export const maxDuration = 300;

const VFS_BOT_APP = "vfs-global-bot";
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
  grafanaRequestHeaders: Record<string, string>;
  from: number;
  to: number;
  app: string;
  lokiNamespace?: string | null;
  query: string;
  requestId: string;
}): Promise<LogEntry[]> {
  const { base, grafanaRequestHeaders, from, to, app, lokiNamespace, query, requestId } = params;
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
      ...grafanaRequestHeaders,
      "User-Agent": "Mozilla/5.0 (compatible; ExposureCheckCohort/1.0)",
      "x-datasource-uid": LOKI_DATASOURCE_UID,
      "x-grafana-org-id": "1",
      "x-plugin-id": "loki",
      "x-query-group-id": "exposure-check-cohort",
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

  let body: {
    from?: unknown;
    to?: unknown;
    deploymentEnv?: string;
    target?: string;
    dedupe?: boolean;
    logSource?: unknown;
  };
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
  const dedupe = body.dedupe !== false;
  const logSource: ExposureCohortLogSource =
    body.logSource === "captured_image" ? "captured_image" : "in_house_ver";
  const sourceMeta = EXPOSURE_COHORT_LOG_SOURCES[logSource];

  const base = getGrafanaBase();
  const grafanaAuth = await resolveGrafanaDsQueryHeaders(base);
  if (!grafanaAuth.ok) {
    return NextResponse.json({ error: grafanaAuth.error }, { status: 502 });
  }
  const grafanaRequestHeaders = grafanaAuth.headers;

  const raw = await queryLokiLogs({
    base,
    grafanaRequestHeaders,
    from: fromVal,
    to: toVal,
    app: target,
    lokiNamespace: vfsLokiNamespace,
    query: sourceMeta.lokiQuery,
    requestId: `exposure_check_${logSource}`,
  });

  const parsed = raw
    .map((entry) => parseExposureCohortRow(entry, logSource))
    .filter(Boolean) as NonNullable<ReturnType<typeof parseExposureCohortRow>>[];
  const rows = dedupe ? dedupeExposureCohortRows(parsed) : parsed;

  return NextResponse.json({
    from: fromVal,
    to: toVal,
    deploymentEnv,
    target,
    vfsLokiNamespace,
    logSource,
    lokiQuery: sourceMeta.lokiQuery,
    totals: {
      lokiLines: raw.length,
      parsedRows: parsed.length,
      rowCount: rows.length,
      withPassport: rows.filter((r) => r.passportNumber).length,
    },
    rows,
  });
}
