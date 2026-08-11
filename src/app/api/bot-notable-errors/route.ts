import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  analyzeBotNotableErrors,
  buildBotNotableErrorsLokiExpr,
} from "@/lib/botNotableErrors";
import {
  extractLokiQueryError,
  fetchLokiQueryWithRetry,
  getGrafanaBase,
  isGrafanaConfigured,
  loginGrafanaCookie,
  LOKI_DATASOURCE_UID,
  LOKI_MAX_LINES_PER_QUERY,
} from "@/lib/grafanaLoki";

const INTERVAL_MS: Record<string, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

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

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isGrafanaConfigured()) {
    return NextResponse.json({ error: "GRAFANA_URL not configured" }, { status: 500 });
  }

  let body: {
    from?: number | string;
    to?: number | string;
    interval?: string;
    fromCountry?: string;
    toCountry?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const fromCountry = typeof body.fromCountry === "string" ? body.fromCountry.trim() : "";
  const toCountry = typeof body.toCountry === "string" ? body.toCountry.trim() : "";
  const lokiExpr = buildBotNotableErrorsLokiExpr({
    fromCountry: fromCountry || undefined,
    toCountry: toCountry || undefined,
  });

  const fromVal = parseTime(body.from);
  const toVal = parseTime(body.to);
  let from: number;
  let to: number;
  if (fromVal != null && toVal != null && fromVal < toVal) {
    from = fromVal;
    to = toVal;
  } else {
    const interval = body.interval ?? "6h";
    to = Date.now();
    from = to - (INTERVAL_MS[interval] ?? INTERVAL_MS["6h"]);
  }

  const base = getGrafanaBase();
  let cookieHeader: string;
  try {
    cookieHeader = await loginGrafanaCookie(base);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Grafana login failed" },
      { status: 502 }
    );
  }
  if (!cookieHeader) {
    return NextResponse.json({ error: "Grafana login failed (no session cookie)" }, { status: 502 });
  }

  const queryBody = {
    queries: [
      {
        expr: lokiExpr,
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

  const { httpStatus, raw, logs } = await fetchLokiQueryWithRetry({
    url: `${base}/api/ds/query?ds_type=loki&requestId=${encodeURIComponent("bot-notable-errors")}`,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; UiTest-BotErrors/1.0)",
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      Origin: base,
      "x-datasource-uid": LOKI_DATASOURCE_UID,
      "x-grafana-org-id": "1",
      "x-plugin-id": "loki",
      "x-query-group-id": "bot-notable-errors",
    },
    body: queryBody,
    requestId: "bot-notable-errors",
  });

  const lokiErr = extractLokiQueryError(raw);
  if (!httpStatus || httpStatus >= 400 || lokiErr) {
    return NextResponse.json(
      { error: lokiErr ?? `Loki query failed (${httpStatus})`, lokiExpr },
      { status: 502 }
    );
  }

  const analysis = analyzeBotNotableErrors(logs);

  return NextResponse.json({
    lokiExpr,
    logs,
    ...analysis,
  });
}
