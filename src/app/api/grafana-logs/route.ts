import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { resolveGrafanaDsQueryHeaders } from "@/lib/grafanaAuth";
import {
  fetchLokiQueryWithRetry,
  getGrafanaBase,
  isGrafanaConfigured,
  LOKI_DATASOURCE_UID,
} from "@/lib/grafanaLoki";

const INTERVAL_MS: Record<string, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isGrafanaConfigured()) {
    return NextResponse.json(
      { error: "GRAFANA_URL not configured" },
      { status: 500 }
    );
  }

  let body: { interval?: string; from?: number | string; to?: number | string; query?: string; target?: string; cookie?: string; additionalFilter?: string; additionalFilters?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const useProvidedCookie = typeof body.cookie === "string" && body.cookie.trim().length > 0;

  const query = typeof body.query === "string" ? body.query : "";
  const target =
    typeof body.target === "string" ? body.target.trim() || "azure-liveness-bot" : "azure-liveness-bot";
  const additionalFilter = typeof body.additionalFilter === "string" ? body.additionalFilter.trim() : "";
  const additionalFilters: string[] = [];
  if (Array.isArray(body.additionalFilters)) {
    for (const f of body.additionalFilters) {
      if (typeof f === "string" && f.trim()) additionalFilters.push(f.trim());
    }
  }
  if (additionalFilters.length === 0 && additionalFilter) {
    additionalFilters.push(additionalFilter);
  }

  function parseTime(v: number | string | undefined): number | null {
    if (v == null) return null;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) return n;
      const d = Date.parse(v);
      return Number.isFinite(d) ? d : null;
    }
    return null;
  }

  let from: number;
  let to: number;
  const fromVal = parseTime(body.from);
  const toVal = parseTime(body.to);
  if (fromVal != null && toVal != null && fromVal < toVal) {
    from = fromVal;
    to = toVal;
  } else {
    const interval = body.interval ?? "6h";
    const intervalMs = INTERVAL_MS[interval] ?? INTERVAL_MS["6h"];
    to = Date.now();
    from = to - intervalMs;
  }
  const intervalMs = to - from;

  const base = getGrafanaBase();
  const loginUrl = `${base}/login`;

  let grafanaRequestHeaders: Record<string, string>;
  if (useProvidedCookie) {
    grafanaRequestHeaders = {
      "User-Agent": "Mozilla/5.0 (compatible; Grafana-Logs-UI/1.0)",
      Accept: "application/json",
      "Content-Type": "application/json",
      Referer: loginUrl,
      Origin: base,
      Cookie: body.cookie!.trim(),
    };
  } else {
    const auth = await resolveGrafanaDsQueryHeaders(base);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: 502 });
    }
    grafanaRequestHeaders = {
      ...auth.headers,
      Referer: loginUrl,
      "User-Agent": "Mozilla/5.0 (compatible; Grafana-Logs-UI/1.0)",
    };
  }

  let expr = query
    ? `{app="${target}"} |= \`${query.replace(/`/g, "\\`")}\``
    : `{app="${target}"}`;
  for (const filter of additionalFilters) {
    expr += ` |= \`${filter.replace(/`/g, "\\`")}\``;
  }

  const queryBody = {
    queries: [
      {
        expr,
        queryType: "range",
        refId: "logs",
        maxLines: 500,
        datasource: { type: "loki", uid: LOKI_DATASOURCE_UID },
        datasourceId: 1,
        intervalMs: intervalMs,
      },
    ],
    from: String(from),
    to: String(to),
  };

  const { httpStatus, logs } = await fetchLokiQueryWithRetry({
    url: `${base}/api/ds/query?ds_type=loki&requestId=logs_1`,
    headers: {
      ...grafanaRequestHeaders,
      "x-datasource-uid": LOKI_DATASOURCE_UID,
      "x-grafana-org-id": "1",
      "x-plugin-id": "loki",
      "x-query-group-id": "logs-ui",
    },
    body: queryBody,
    requestId: "logs_1",
  });

  return NextResponse.json({ logs, rawStatus: httpStatus });
}
