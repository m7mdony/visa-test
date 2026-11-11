import { stripAnsiCodes } from "@/components/AnsiLogLine";
import type { LogEntry } from "@/lib/grafanaLoki";

export type DocumentVerificationFailedRow = {
  time: string;
  email: string | null;
  passportNumber: string | null;
  fromCountry: string | null;
  toCountry: string | null;
  line: string;
};

function extractField(line: string, key: string): string | null {
  const re = new RegExp(`\\b${key}=([^\\s,]+)`, "i");
  const m = line.match(re);
  return m?.[1]?.trim() ?? null;
}

function isHttpTraceLine(clean: string): boolean {
  return (
    /\[(?:GET|POST|PUT|PATCH|DELETE)\s+https?:/i.test(clean) ||
    /\]\s*Response:\s*\{/i.test(clean) ||
    /\]\s*Request:\s*\{/i.test(clean)
  );
}

/** Countable terminal: `warn: … UploadApplicantDocument … Document verification failed …` */
export function isDocumentVerificationFailedWarnLine(line: string): boolean {
  const clean = stripAnsiCodes(line);
  if (!/Document verification failed/i.test(clean)) return false;
  if (isHttpTraceLine(clean)) return false;
  if (!/\bwarn:/i.test(clean)) return false;
  return true;
}

export function buildDocumentVerificationFailedRows(logs: LogEntry[]): DocumentVerificationFailedRow[] {
  const byKey = new Map<string, DocumentVerificationFailedRow>();
  for (const entry of logs) {
    if (!isDocumentVerificationFailedWarnLine(entry.line)) continue;
    const clean = stripAnsiCodes(entry.line);
    const email = extractField(clean, "email")?.toLowerCase() ?? null;
    const passportNumber = extractField(clean, "passportNumber") ?? null;
    const key = `${entry.time}\0${passportNumber ?? ""}\0${email ?? ""}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      time: entry.time,
      email,
      passportNumber,
      fromCountry: extractField(clean, "fromCountry"),
      toCountry: extractField(clean, "toCountry"),
      line: entry.line,
    });
  }
  const rows = [...byKey.values()];
  rows.sort((a, b) => b.time.localeCompare(a.time));
  return rows;
}

export function distinctPassportNumbers(rows: DocumentVerificationFailedRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const p = r.passportNumber?.trim();
    if (p) set.add(p);
  }
  return [...set];
}
