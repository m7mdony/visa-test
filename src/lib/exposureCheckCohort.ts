import type { LogEntry } from "@/lib/grafanaLoki";
import {
  extractEmailFromLine,
  extractLogField,
  isInHouseVerificationPassedLine,
} from "@/lib/inHouseVerVideos";
import { normalizePassportKey } from "@/lib/visaflowDashboardPassports";

export type ExposureCohortLogSource = "in_house_ver" | "captured_image";

export const EXPOSURE_COHORT_LOG_SOURCES: Record<
  ExposureCohortLogSource,
  { lokiQuery: string; label: string; description: string }
> = {
  in_house_ver: {
    lokiQuery: "In-house ver",
    label: "In-house ver",
    description: "VFS in-house verification pass/fail lines",
  },
  captured_image: {
    lokiQuery: "The captured image is not",
    label: 'The captured image is not',
    description: "Azure / VFS captured-image quality errors (e.g. [1093])",
  },
};

export type ExposureCohortEventKind = "passed" | "failed" | "other";

export type ExposureCohortRow = {
  rowKey: string;
  email: string;
  passportNumber: string | null;
  eventAt: string;
  eventLine: string;
  eventKind: ExposureCohortEventKind;
};

function passportFromLine(line: string): string | null {
  const keys = ["passportNumber", "PassportNumber", "passport", "Passport"];
  for (const k of keys) {
    const v = extractLogField(line, k);
    if (v?.trim()) return v.trim();
  }
  const bracket = line.match(/passport=([^,\]\s]+)/i);
  return bracket?.[1]?.trim() ?? null;
}

function classifyKind(line: string, logSource: ExposureCohortLogSource): ExposureCohortEventKind {
  if (logSource === "captured_image") return "failed";
  if (isInHouseVerificationPassedLine(line)) return "passed";
  if (/in-house identity verification failed/i.test(line)) return "failed";
  if (/in-house verification failed/i.test(line)) return "failed";
  if (/attempt\s+\d+\/\d+:\s*failed/i.test(line)) return "failed";
  return "other";
}

export function parseExposureCohortRow(
  entry: LogEntry,
  logSource: ExposureCohortLogSource = "in_house_ver"
): ExposureCohortRow | null {
  const email = extractEmailFromLine(entry.line);
  if (!email) return null;
  const passportNumber = passportFromLine(entry.line);
  const eventKind = classifyKind(entry.line, logSource);
  const rowKey = `${entry.time}|${email}|${passportNumber ?? ""}`;
  return {
    rowKey,
    email,
    passportNumber,
    eventAt: entry.time,
    eventLine: entry.line,
    eventKind,
  };
}

/** Latest event per passport (fallback: email-only rows without passport stay separate). */
export function dedupeExposureCohortRows(rows: ExposureCohortRow[]): ExposureCohortRow[] {
  const byKey = new Map<string, ExposureCohortRow>();
  const sorted = [...rows].sort((a, b) => a.eventAt.localeCompare(b.eventAt));
  for (const row of sorted) {
    const key = row.passportNumber?.trim()
      ? normalizePassportKey(row.passportNumber)
      : `email:${row.email}`;
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => b.eventAt.localeCompare(a.eventAt));
}

export function pickColorVideoUrl(videos: string[] | undefined): string | null {
  const list = (videos ?? []).map((v) => v.trim()).filter(Boolean);
  return list[0] ?? null;
}

export const FACE_PRECHECK_FAILURE = {
  clipped: "FacePrecheckClippedExposure",
  lowQuality: "FacePrecheckLowQuality",
  noFace: "FacePrecheckNoFace",
} as const;

export function precheckVerdictFromFailureReason(
  reason: string | null | undefined
): "pass" | "clipped" | "low_quality" | "no_face" | "other_fail" | null {
  if (!reason?.trim()) return null;
  const r = reason.trim();
  if (r === FACE_PRECHECK_FAILURE.clipped) return "clipped";
  if (r === FACE_PRECHECK_FAILURE.lowQuality) return "low_quality";
  if (r === FACE_PRECHECK_FAILURE.noFace) return "no_face";
  if (r.startsWith("FacePrecheck")) return "other_fail";
  return null;
}
