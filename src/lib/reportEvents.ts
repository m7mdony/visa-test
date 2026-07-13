import { normalizePassportKey } from "@/lib/visaflowDashboardPassports";

export type StatusVideoEvent = {
  status: "APPROVED" | "DENIED";
  email: string;
  passportNumber: string | null;
  at: string;
};

export type EmailStatEvent = {
  email: string;
  passportNumber: string | null;
  at: string;
};

export type ErroredAttemptEvent = {
  email: string;
  passportNumber: string | null;
  reason: string;
  at: string;
};

/** Attempt-passed / in-house timing log lines with identity for route filtering. */
export type BotTimingLogEvent = {
  email: string;
  passportNumber: string | null;
  line: string;
  at: string;
};

export function buildEmailToPassportMap(
  pairs: Array<{ email: string; passportNumber: string | null | undefined }>
): Map<string, string> {
  const m = new Map<string, string>();
  for (const { email, passportNumber } of pairs) {
    const em = email?.trim().toLowerCase();
    const pn = passportNumber?.trim();
    if (!em || !pn) continue;
    m.set(em, pn);
  }
  return m;
}

export function resolvePassportForLog(
  line: string,
  email: string | null,
  emailToPassport: Map<string, string>
): string | null {
  const passportFromLine =
    extractLogField(line, "PassportNumber") ??
    extractLogField(line, "passport") ??
    extractBracketPassport(line);
  if (passportFromLine) return passportFromLine;
  if (email) {
    const p = emailToPassport.get(email.toLowerCase());
    if (p) return p;
  }
  return null;
}

function extractLogField(line: string, key: string): string | undefined {
  const r = new RegExp(`${key}=([^\\s,\\]]+)`, "i");
  const m = line.match(r);
  return m?.[1]?.trim();
}

function extractBracketPassport(line: string): string | null {
  const m = line.match(/\[passport=([^\]]+)\]/i);
  return m?.[1]?.trim() || null;
}

export function extractEmailFromIdnfyOrVfsLine(line: string): string | null {
  const loginUser = line.match(/"loginUser"\s*:\s*"([^"]+)"/i);
  if (loginUser?.[1]?.includes("@")) return loginUser[1].trim().toLowerCase();
  const emailEq = line.match(/\bemail=([^\s,]+)/i);
  if (emailEq?.[1]?.includes("@")) return emailEq[1].trim().toLowerCase();
  return null;
}

export function mergeEmailToPassportMap(...maps: Map<string, string>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of maps) {
    for (const [email, passport] of m) {
      const em = email.trim().toLowerCase();
      const pn = passport?.trim();
      if (!em || !pn) continue;
      out.set(em, pn);
    }
  }
  return out;
}

export function collectEmailsFromReportData(data: {
  reportEvents?: {
    statusVideos?: Array<{ email: string }>;
    inHousePassed?: Array<{ email: string }>;
    deniedApplicants?: Array<{ email: string }>;
    erroredAttempts?: Array<{ email: string }>;
    attemptPassedTimings?: Array<{ email: string }>;
    inHouseTimingLogs?: Array<{ email: string }>;
  };
  deniedPassportRows?: Array<{ email: string }>;
}): string[] {
  const emails = new Set<string>();
  const add = (e: string | undefined) => {
    const t = e?.trim().toLowerCase();
    if (t && t.includes("@")) emails.add(t);
  };
  for (const r of data.deniedPassportRows ?? []) add(r.email);
  for (const e of data.reportEvents?.statusVideos ?? []) add(e.email);
  for (const e of data.reportEvents?.inHousePassed ?? []) add(e.email);
  for (const e of data.reportEvents?.deniedApplicants ?? []) add(e.email);
  for (const e of data.reportEvents?.erroredAttempts ?? []) add(e.email);
  for (const e of data.reportEvents?.attemptPassedTimings ?? []) add(e.email);
  for (const e of data.reportEvents?.inHouseTimingLogs ?? []) add(e.email);
  return [...emails];
}

export function collectPassportsFromReportData(data: {
  deniedPassportRows?: Array<{ passportNumber: string | null }>;
  reportEvents?: {
    statusVideos?: StatusVideoEvent[];
    inHousePassed?: EmailStatEvent[];
    deniedApplicants?: EmailStatEvent[];
    erroredAttempts?: ErroredAttemptEvent[];
    attemptPassedTimings?: BotTimingLogEvent[];
    inHouseTimingLogs?: BotTimingLogEvent[];
  };
}): string[] {
  const keys = new Set<string>();
  const add = (pn: string | null | undefined) => {
    const t = pn?.trim();
    if (!t) return;
    keys.add(normalizePassportKey(t));
  };
  for (const r of data.deniedPassportRows ?? []) add(r.passportNumber);
  for (const e of data.reportEvents?.statusVideos ?? []) add(e.passportNumber);
  for (const e of data.reportEvents?.inHousePassed ?? []) add(e.passportNumber);
  for (const e of data.reportEvents?.deniedApplicants ?? []) add(e.passportNumber);
  for (const e of data.reportEvents?.erroredAttempts ?? []) add(e.passportNumber);
  for (const e of data.reportEvents?.attemptPassedTimings ?? []) add(e.passportNumber);
  for (const e of data.reportEvents?.inHouseTimingLogs ?? []) add(e.passportNumber);
  return [...keys];
}
