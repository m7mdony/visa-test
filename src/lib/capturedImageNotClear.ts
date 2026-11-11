import { stripAnsiCodes } from "@/components/AnsiLogLine";
import type { LogEntry } from "@/lib/grafanaLoki";
import { extractEmailFromLine, extractLogField, extractUrnFromLine } from "@/lib/inHouseVerVideos";

export const CAPTURED_IMAGE_NOT_CLEAR_LOKI_FILTERS = [
  "[1093]",
  "The captured image is not clear",
] as const;

export type CapturedImageNotClearRow = {
  time: string;
  email: string | null;
  passportNumber: string | null;
  urn: string | null;
  fromCountry: string | null;
  toCountry: string | null;
  line: string;
};

export function isCapturedImageNotClearLine(line: string): boolean {
  const clean = stripAnsiCodes(line);
  if (!/\[1093\]/i.test(clean)) return false;
  if (!/The captured image is not clear/i.test(clean)) return false;
  if (/\]\s*Response:\s*\{/i.test(clean) && !/warn:/i.test(clean)) return false;
  return true;
}

export function buildCapturedImageNotClearRows(logs: LogEntry[]): CapturedImageNotClearRow[] {
  const byKey = new Map<string, CapturedImageNotClearRow>();
  for (const entry of logs) {
    if (!isCapturedImageNotClearLine(entry.line)) continue;
    const clean = stripAnsiCodes(entry.line);
    const email = extractEmailFromLine(clean);
    const passportNumber = extractLogField(clean, "passportNumber") ?? null;
    const urn = extractUrnFromLine(clean);
    const key = `${entry.time}\0${passportNumber ?? ""}\0${email ?? ""}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      time: entry.time,
      email,
      passportNumber,
      urn,
      fromCountry: extractLogField(clean, "fromCountry") ?? null,
      toCountry: extractLogField(clean, "toCountry") ?? null,
      line: entry.line,
    });
  }
  const rows = [...byKey.values()];
  rows.sort((a, b) => b.time.localeCompare(a.time));
  return rows;
}

export function distinctPassportNumbersFromCapturedImageRows(rows: CapturedImageNotClearRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const p = r.passportNumber?.trim();
    if (p) set.add(p);
  }
  return [...set];
}
