import {
  buildLokiLineFilterExpr,
  fetchLokiQueryWithRetry,
  isIdnfyStatusDeniedLine,
  LOKI_DATASOURCE_UID,
  LOKI_MAX_LINES_PER_QUERY,
  LOKI_QUERY_BATCH_SIZE,
  resolvePassportFromEmailLogs,
  runInBatches,
  type LogEntry,
} from "@/lib/grafanaLoki";

export type DeniedPassportRow = {
  deniedAt: string;
  email: string;
  urn: string | null;
  aurn: string | null;
  passportNumber: string | null;
  passportLogLinesScanned: number;
};

function lokiLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function queryVfsLogs(params: {
  base: string;
  cookieHeader: string;
  from: number;
  to: number;
  query: string;
  requestId: string;
  app?: string;
  lokiNamespace?: string | null;
  maxLines?: number;
}): Promise<LogEntry[]> {
  const {
    base,
    cookieHeader,
    from,
    to,
    query,
    requestId,
    app = "vfs-global-bot",
    lokiNamespace,
    maxLines = LOKI_MAX_LINES_PER_QUERY,
  } = params;
  const appEsc = lokiLabelValue(app);
  const selector =
    lokiNamespace && lokiNamespace.trim().length > 0
      ? `{namespace="${lokiLabelValue(lokiNamespace.trim())}", app="${appEsc}"}`
      : `{app="${appEsc}"}`;
  const expr = buildLokiLineFilterExpr(selector, query);
  const cappedMaxLines = Math.min(maxLines, LOKI_MAX_LINES_PER_QUERY);
  const queryBody = {
    queries: [
      {
        expr,
        queryType: "range",
        refId: "logs",
        maxLines: cappedMaxLines,
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
      "User-Agent": "Mozilla/5.0 (compatible; UiTest-DeniedPassports/1.0)",
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      Origin: base,
      "x-datasource-uid": LOKI_DATASOURCE_UID,
      "x-grafana-org-id": "1",
      "x-plugin-id": "loki",
      "x-query-group-id": "ui-test-denied-passports",
    },
    body: queryBody,
    requestId,
  });
  return logs;
}

function extractDeniedEmail(line: string): string | null {
  const loginUser = line.match(/"loginUser"\s*:\s*"([^"]+)"/i);
  if (loginUser?.[1]?.includes("@")) return loginUser[1].trim().toLowerCase();
  const emailEq = line.match(/\bemail=([^\s,]+)/i);
  if (emailEq?.[1]?.includes("@")) return emailEq[1].trim().toLowerCase();
  return null;
}

function extractJsonField(line: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, "i");
  const m = line.match(re);
  return m?.[1]?.trim() || null;
}

export function parseDeniedEventsFromLogs(
  logs: LogEntry[]
): Omit<DeniedPassportRow, "passportNumber" | "passportLogLinesScanned">[] {
  const out: Omit<DeniedPassportRow, "passportNumber" | "passportLogLinesScanned">[] = [];
  for (const entry of logs) {
    if (!isIdnfyStatusDeniedLine(entry.line)) continue;
    const email = extractDeniedEmail(entry.line);
    if (!email) continue;
    out.push({
      deniedAt: entry.time,
      email,
      urn: extractJsonField(entry.line, "urn") ?? extractJsonField(entry.line, "aurn"),
      aurn: extractJsonField(entry.line, "aurn"),
    });
  }
  out.sort((a, b) => b.deniedAt.localeCompare(a.deniedAt));
  return out;
}

export async function buildDeniedPassportRows(params: {
  base: string;
  cookieHeader: string;
  from: number;
  to: number;
  app?: string;
  lokiNamespace?: string | null;
  deniedLogs: LogEntry[];
  maxEmails?: number;
}): Promise<{ rows: DeniedPassportRow[]; errors: string[] }> {
  const { base, cookieHeader, from, to, app, lokiNamespace, deniedLogs, maxEmails = 80 } = params;
  const deniedEvents = parseDeniedEventsFromLogs(deniedLogs);
  const uniqueEmails = [...new Set(deniedEvents.map((e) => e.email))].slice(0, maxEmails);
  const errors: string[] = [];

  const emailTasks = uniqueEmails.map((email) => async () => {
    try {
      const emailLogs = await queryVfsLogs({
        base,
        cookieHeader,
        from,
        to,
        app,
        lokiNamespace,
        query: `email=${email}`,
        requestId: `denied_passport_${email.replace(/[^a-z0-9]/gi, "_")}`,
        maxLines: 3000,
      });
      return {
        email,
        passport: resolvePassportFromEmailLogs(email, emailLogs),
        linesScanned: emailLogs.length,
      };
    } catch (e: unknown) {
      errors.push(`${email}: ${e instanceof Error ? e.message : "query failed"}`);
      return { email, passport: null, linesScanned: 0 };
    }
  });

  const passportResults = await runInBatches(emailTasks, LOKI_QUERY_BATCH_SIZE);
  const passportByEmail = new Map<string, { passport: string | null; linesScanned: number }>();
  for (const r of passportResults) {
    passportByEmail.set(r.email, { passport: r.passport, linesScanned: r.linesScanned });
  }

  const rows: DeniedPassportRow[] = deniedEvents.map((ev) => {
    const p = passportByEmail.get(ev.email);
    return {
      ...ev,
      passportNumber: p?.passport ?? null,
      passportLogLinesScanned: p?.linesScanned ?? 0,
    };
  });

  return { rows, errors };
}
