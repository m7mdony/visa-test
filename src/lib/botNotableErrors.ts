import type { LogEntry } from "@/lib/grafanaLoki";
import { stripAnsiCodes } from "@/components/AnsiLogLine";

/** Base Loki filter from Grafana — notable bot errors only (no route filter). */
export const BOT_NOTABLE_ERRORS_LOKI_BASE =
  '{app="vfs-global-bot"} |= `error` != `No slots` != `Please select different date` != `are` != `error":null` != `fromCountry=egy` != `email rejected by VFS` != `\\"code\\":\\"999\\",`';

/** @deprecated use buildBotNotableErrorsLokiExpr() */
export const BOT_NOTABLE_ERRORS_LOKI_EXPR = BOT_NOTABLE_ERRORS_LOKI_BASE;

function escapeLogQLBacktick(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

export function buildBotNotableErrorsLokiExpr(opts?: {
  fromCountry?: string;
  toCountry?: string;
}): string {
  let expr = BOT_NOTABLE_ERRORS_LOKI_BASE;
  const from = opts?.fromCountry?.trim().toLowerCase();
  const to = opts?.toCountry?.trim().toLowerCase();
  if (from) expr += ` |= \`fromCountry=${escapeLogQLBacktick(from)}\``;
  if (to) expr += ` |= \`toCountry=${escapeLogQLBacktick(to)}\``;
  return expr;
}

export type ParsedBotLog = {
  time: string;
  line: string;
  level: "error" | "debug" | "warn" | "unknown";
  email: string | null;
  fromCountry: string | null;
  toCountry: string | null;
  passportNumber: string | null;
  urn: string | null;
  errorKey: string;
  rawMessage: string;
};

export type ErrorTypeCount = {
  errorKey: string;
  count: number;
  sampleLine: string;
};

export type EmailErrorGroup = {
  email: string;
  count: number;
  errorTypes: { errorKey: string; count: number }[];
  logs: ParsedBotLog[];
};

const METADATA_RE =
  /\s+(email=\S+|fromCountry=\S+|toCountry=\S+|passportNumber=\S+|urn=\S+)(?:\s+(?:email=\S+|fromCountry=\S+|toCountry=\S+|passportNumber=\S+|urn=\S+))*$/i;

function extractField(line: string, key: string): string | null {
  const re = new RegExp(`\\b${key}=([^\\s]+)`, "i");
  const m = line.match(re);
  return m?.[1]?.trim() ?? null;
}

function stripLogPrefix(line: string): { level: ParsedBotLog["level"]; message: string } {
  const clean = stripAnsiCodes(line);
  const m = clean.match(/^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+(error|debug|warn):\s+([\s\S]*)$/i);
  if (m) {
    return { level: m[1].toLowerCase() as ParsedBotLog["level"], message: m[2].trim() };
  }
  const bare = clean.match(/^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+([\s\S]*)$/);
  if (bare) return { level: "unknown", message: bare[1].trim() };
  return { level: "unknown", message: clean.trim() };
}

function stripTrailingMetadata(message: string): string {
  return message.replace(METADATA_RE, "").trim();
}

function normalizeUrls(text: string): string {
  return text.replace(/https:\/\/[^\s|\]]+/gi, (url) => {
    try {
      const u = new URL(url);
      return u.pathname || url;
    } catch {
      return url;
    }
  });
}

function tryExtractJsonErrorMessage(text: string): string | null {
  if (!text.startsWith("{")) return null;
  const jsonStart = text.indexOf("{");
  const jsonPart = text.slice(jsonStart);
  try {
    const parsed = JSON.parse(jsonPart) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const walk = (node: unknown, depth: number): string | null => {
      if (depth > 8 || node == null) return null;
      if (typeof node === "object") {
        const o = node as Record<string, unknown>;
        if (typeof o.description === "string" && o.description.trim()) return o.description.trim();
        if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
        if (o.error && typeof o.error === "object") {
          const inner = walk(o.error, depth + 1);
          if (inner) return inner;
        }
        for (const v of Object.values(o)) {
          const inner = walk(v, depth + 1);
          if (inner) return inner;
        }
      }
      return null;
    };
    return walk(parsed, 0);
  } catch {
    const desc = jsonPart.match(/"description"\s*:\s*"([^"]+)"/i);
    if (desc?.[1]) return desc[1];
    return null;
  }
}

/** Collapse heterogeneous bot error lines into a stable grouping key. */
export function normalizeErrorKey(rawMessage: string): string {
  let msg = stripAnsiCodes(stripTrailingMetadata(rawMessage));
  msg = msg.replace(/^\[(setup|POST|GET)\b[^\]]*\]\s+/i, "");

  const jsonDesc = tryExtractJsonErrorMessage(msg);
  if (jsonDesc) {
    msg = jsonDesc;
  } else if (msg.includes(" - [") && /\[\d+\]/.test(msg)) {
    const bracket = msg.match(/\[\d+\]\s*([^[\]|]+(?:\[[^\]]+\])?)?$/);
    if (bracket?.[0]) msg = msg.replace(/\s*-\s*\[\d+\].*$/, ` - [code] ${bracket[0].replace(/^\[\d+\]\s*/, "").trim()}`);
  }

  msg = msg.replace(/^[0-9]{3}\s*\|\s*/g, "<code> | ");
  msg = msg.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
  msg = msg.replace(/\[ApplicantID:\s*[^\]]+\]/gi, "[ApplicantID: …]");
  msg = msg.replace(/\[RequestRefNumber:\s*[^\]]+\]/gi, "[RequestRefNumber: …]");
  msg = msg.replace(/\[ReferenceNumber:\s*[^\]]+\]/gi, "[ReferenceNumber: …]");
  msg = msg.replace(/\bDuration:\s*\d+s\b/gi, "Duration: <N>s");
  msg = msg.replace(/\bsession lasted\s+[\d.]+s\b/gi, "session lasted <N>s");
  msg = msg.replace(/\bstatus code\s+\d+\b/gi, "status code <N>");
  msg = msg.replace(/\bStatus Code:\s*\d+\b/gi, "Status Code: <N>");
  msg = msg.replace(/\btook\s+\d+ms\b/gi, "took <N>ms");
  msg = msg.replace(/\b(403\d{3}|429\d{3}|1037|1040|4923|4901)\b/g, "<code>");
  msg = msg.replace(/\|\s*Proxy:\s*\S+/gi, "| Proxy: …");
  msg = msg.replace(/\([^)]*\)/g, (m) => (m.length > 80 ? "(…)" : m));
  msg = normalizeUrls(msg);
  msg = msg.replace(/\s+/g, " ").trim();

  if (!msg) return "(empty)";
  return msg.length > 220 ? `${msg.slice(0, 217)}…` : msg;
}

export function parseBotLogEntry(entry: LogEntry): ParsedBotLog {
  const { level, message } = stripLogPrefix(entry.line);
  const rawMessage = stripTrailingMetadata(stripAnsiCodes(message));
  const email = extractField(stripAnsiCodes(entry.line), "email")?.toLowerCase() ?? null;

  return {
    time: entry.time,
    line: entry.line,
    level,
    email,
    fromCountry: extractField(stripAnsiCodes(entry.line), "fromCountry"),
    toCountry: extractField(stripAnsiCodes(entry.line), "toCountry"),
    passportNumber: extractField(stripAnsiCodes(entry.line), "passportNumber"),
    urn: extractField(stripAnsiCodes(entry.line), "urn"),
    rawMessage,
    errorKey: normalizeErrorKey(message),
  };
}

export function analyzeBotNotableErrors(logs: LogEntry[]): {
  parsed: ParsedBotLog[];
  errorTypeCounts: ErrorTypeCount[];
  byEmail: EmailErrorGroup[];
  summary: {
    totalLogs: number;
    uniqueErrorTypes: number;
    uniqueEmails: number;
    logsWithoutEmail: number;
  };
} {
  const parsed = logs.map(parseBotLogEntry);

  const typeMap = new Map<string, { count: number; sampleLine: string }>();
  for (const p of parsed) {
    const cur = typeMap.get(p.errorKey);
    if (cur) cur.count += 1;
    else typeMap.set(p.errorKey, { count: 1, sampleLine: p.line });
  }

  const errorTypeCounts: ErrorTypeCount[] = [...typeMap.entries()]
    .map(([errorKey, v]) => ({ errorKey, count: v.count, sampleLine: v.sampleLine }))
    .sort((a, b) => b.count - a.count || a.errorKey.localeCompare(b.errorKey));

  const emailMap = new Map<string, ParsedBotLog[]>();
  let logsWithoutEmail = 0;
  for (const p of parsed) {
    if (!p.email) {
      logsWithoutEmail += 1;
      continue;
    }
    const list = emailMap.get(p.email) ?? [];
    list.push(p);
    emailMap.set(p.email, list);
  }

  const byEmail: EmailErrorGroup[] = [...emailMap.entries()]
    .map(([email, emailLogs]) => {
      const errCounts = new Map<string, number>();
      for (const l of emailLogs) {
        errCounts.set(l.errorKey, (errCounts.get(l.errorKey) ?? 0) + 1);
      }
      return {
        email,
        count: emailLogs.length,
        errorTypes: [...errCounts.entries()]
          .map(([errorKey, count]) => ({ errorKey, count }))
          .sort((a, b) => b.count - a.count),
        logs: emailLogs.sort((a, b) => a.time.localeCompare(b.time)),
      };
    })
    .sort((a, b) => b.count - a.count || a.email.localeCompare(b.email));

  return {
    parsed,
    errorTypeCounts,
    byEmail,
    summary: {
      totalLogs: parsed.length,
      uniqueErrorTypes: errorTypeCounts.length,
      uniqueEmails: byEmail.length,
      logsWithoutEmail,
    },
  };
}
