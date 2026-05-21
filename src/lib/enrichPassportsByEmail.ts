import {
  fetchLokiQueryWithRetry,
  LOKI_DATASOURCE_UID,
  LOKI_MAX_LINES_PER_QUERY,
  LOKI_QUERY_BATCH_SIZE,
  resolvePassportFromEmailLogs,
  runInBatches,
  type LogEntry,
} from "@/lib/grafanaLoki";

function lokiLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function queryEmailLogs(params: {
  base: string;
  cookieHeader: string;
  from: number;
  to: number;
  email: string;
  app?: string;
  lokiNamespace?: string | null;
  requestId: string;
}): Promise<LogEntry[]> {
  const { base, cookieHeader, from, to, email, app = "vfs-global-bot", lokiNamespace, requestId } = params;
  const appEsc = lokiLabelValue(app);
  const selector =
    lokiNamespace && lokiNamespace.trim().length > 0
      ? `{namespace="${lokiLabelValue(lokiNamespace.trim())}", app="${appEsc}"}`
      : `{app="${appEsc}"}`;
  const expr = `${selector} |= "${lokiLabelValue(email)}"`;
  const { logs } = await fetchLokiQueryWithRetry({
    url: `${base}/api/ds/query?ds_type=loki&requestId=${encodeURIComponent(requestId)}`,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; UiTest-EnrichPassports/1.0)",
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      Origin: base,
      "x-datasource-uid": LOKI_DATASOURCE_UID,
      "x-grafana-org-id": "1",
      "x-plugin-id": "loki",
      "x-query-group-id": "ui-test-enrich-passports",
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

/** Batch Loki `email=…` queries to resolve passport numbers for log emails. */
export async function lookupPassportsByEmailBatch(params: {
  base: string;
  cookieHeader: string;
  from: number;
  to: number;
  emails: string[];
  app?: string;
  lokiNamespace?: string | null;
  maxEmails?: number;
}): Promise<{ passportByEmail: Map<string, string | null>; errors: string[] }> {
  const { base, cookieHeader, from, to, app, lokiNamespace, maxEmails = 100 } = params;
  const unique = [...new Set(params.emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))].slice(
    0,
    maxEmails
  );
  const errors: string[] = [];
  const tasks = unique.map((email) => async () => {
    try {
      const logs = await queryEmailLogs({
        base,
        cookieHeader,
        from,
        to,
        email,
        app,
        lokiNamespace,
        requestId: `enrich_passport_${email.replace(/[^a-z0-9]/gi, "_")}`,
      });
      return { email, passport: resolvePassportFromEmailLogs(email, logs) };
    } catch (e: unknown) {
      errors.push(`${email}: ${e instanceof Error ? e.message : "query failed"}`);
      return { email, passport: null };
    }
  });
  const results = await runInBatches(tasks, LOKI_QUERY_BATCH_SIZE);
  const passportByEmail = new Map<string, string | null>();
  for (const r of results) passportByEmail.set(r.email, r.passport);
  return { passportByEmail, errors };
}
