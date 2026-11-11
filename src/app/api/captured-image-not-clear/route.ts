import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  buildCapturedImageNotClearRows,
  CAPTURED_IMAGE_NOT_CLEAR_LOKI_FILTERS,
  distinctPassportNumbersFromCapturedImageRows,
} from "@/lib/capturedImageNotClear";
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
  requestId: string;
}): Promise<LogEntry[]> {
  const { base, grafanaRequestHeaders, from, to, app, lokiNamespace, requestId } = params;
  const appEsc = lokiLabelValue(app);
  const selector =
    lokiNamespace && lokiNamespace.trim().length > 0
      ? `{namespace="${lokiLabelValue(lokiNamespace.trim())}", app="${appEsc}"}`
      : `{app="${appEsc}"}`;
  const expr = buildLokiLineFilterExpr(selector, [...CAPTURED_IMAGE_NOT_CLEAR_LOKI_FILTERS]);
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
      "User-Agent": "Mozilla/5.0 (compatible; CapturedImageNotClear/1.0)",
      "x-datasource-uid": LOKI_DATASOURCE_UID,
      "x-grafana-org-id": "1",
      "x-plugin-id": "loki",
      "x-query-group-id": "captured-image-not-clear",
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

  const base = getGrafanaBase();
  const grafanaAuth = await resolveGrafanaDsQueryHeaders(base);
  if (!grafanaAuth.ok) {
    return NextResponse.json({ error: grafanaAuth.error }, { status: 502 });
  }
  const grafanaRequestHeaders = grafanaAuth.headers;

  const rawLogs = await queryLokiLogs({
    base,
    grafanaRequestHeaders,
    from: fromVal,
    to: toVal,
    app: target,
    lokiNamespace: vfsLokiNamespace,
    requestId: "captured_image_not_clear_vfs",
  });

  const rows = buildCapturedImageNotClearRows(rawLogs);
  const passports = distinctPassportNumbersFromCapturedImageRows(rows);

  return NextResponse.json({
    from: fromVal,
    to: toVal,
    target,
    deploymentEnv,
    vfsLokiNamespace,
    lokiFilters: CAPTURED_IMAGE_NOT_CLEAR_LOKI_FILTERS,
    totals: {
      lokiLines: rawLogs.length,
      matchedRows: rows.length,
      distinctPassports: passports.length,
    },
    passports,
    rows,
  });
}
