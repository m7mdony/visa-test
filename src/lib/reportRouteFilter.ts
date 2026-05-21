import type { DeniedPassportRow } from "@/lib/deniedPassports";
import type { ErroredAttemptEvent, EmailStatEvent, StatusVideoEvent } from "@/lib/reportEvents";
import {
  eventMatchesRouteFilter,
  indexPassportRoutes,
  isRouteFilterActive,
  type PassportRouteInfo,
  type RouteFilterSelection,
} from "@/lib/visaflowDashboardClients";

function countMatched<T>(
  items: T[],
  match: (item: T) => boolean
): { matched: number; total: number } {
  let matched = 0;
  for (const item of items) if (match(item)) matched += 1;
  return { matched, total: items.length };
}

export type ReportEventsBundle = {
  statusVideos: StatusVideoEvent[];
  inHousePassed: EmailStatEvent[];
  deniedApplicants: EmailStatEvent[];
  erroredAttempts: ErroredAttemptEvent[];
};

export type FailureReasonRow = {
  reason: string;
  count: number;
  samples?: Array<{
    email: string;
    passportNumber: string | null;
    videoLink: string | null;
  }>;
};

function pickRandomItems<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function buildFailureBreakdownFromAttempts(attempts: ErroredAttemptEvent[]): FailureReasonRow[] {
  const counts = new Map<string, number>();
  const samples = new Map<string, ErroredAttemptEvent[]>();
  for (const a of attempts) {
    const reason = a.reason || "(no error message)";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    const arr = samples.get(reason) ?? [];
    arr.push(a);
    samples.set(reason, arr);
  }
  return [...counts.entries()]
    .map(([reason, count]) => {
      const candidates = samples.get(reason) ?? [];
      const unique = new Map<string, { email: string; passportNumber: string | null; videoLink: string | null }>();
      for (const s of candidates) {
        const key = `${s.email}|${s.passportNumber ?? ""}`;
        if (!unique.has(key)) {
          unique.set(key, { email: s.email, passportNumber: s.passportNumber, videoLink: null });
        }
      }
      return {
        reason,
        count,
        samples: pickRandomItems([...unique.values()], 3),
      };
    })
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export function computeFilteredTopStats(
  events: ReportEventsBundle | undefined,
  routes: PassportRouteInfo[],
  emailToRoute: Map<string, PassportRouteInfo>,
  filter: RouteFilterSelection,
  deniedPassportRows: DeniedPassportRow[]
): {
  approvedVideoCount: number;
  deniedVideoCount: number;
  approvedApplicantCount: number;
  deniedApplicantCount: number;
  erroredVideoAttemptCount: number;
  failureReasonBreakdown: FailureReasonRow[];
  deniedPassportRows: DeniedPassportRow[];
  routeFilterCoverage?: {
    approvedVideosMatched: number;
    approvedVideosTotal: number;
    unmatchedOnDashboard: number;
  };
} {
  const routesByKey = indexPassportRoutes(routes);
  const active = isRouteFilterActive(filter);
  const matches = (email: string, passport: string | null) =>
    eventMatchesRouteFilter(email, passport, routesByKey, emailToRoute, filter);

  if (!events || !active) {
    const breakdown = buildFailureBreakdownFromAttempts(events?.erroredAttempts ?? []);
    const erroredTotal = breakdown.reduce((s, r) => s + r.count, 0);
    return {
      approvedVideoCount: events?.statusVideos.filter((e) => e.status === "APPROVED").length ?? 0,
      deniedVideoCount: events?.statusVideos.filter((e) => e.status === "DENIED").length ?? 0,
      approvedApplicantCount: events?.inHousePassed.length ?? 0,
      deniedApplicantCount: events?.deniedApplicants.length ?? 0,
      erroredVideoAttemptCount: erroredTotal,
      failureReasonBreakdown: breakdown,
      deniedPassportRows,
    };
  }

  const statusVideos = events.statusVideos.filter((e) => matches(e.email, e.passportNumber));
  const inHousePassed = events.inHousePassed.filter((e) => matches(e.email, e.passportNumber));
  const deniedApplicants = events.deniedApplicants.filter((e) => matches(e.email, e.passportNumber));
  const erroredAttempts = events.erroredAttempts.filter((e) => matches(e.email, e.passportNumber));
  const filteredDeniedRows = deniedPassportRows.filter((r) => matches(r.email, r.passportNumber));
  const failureReasonBreakdown = buildFailureBreakdownFromAttempts(erroredAttempts);

  const approvedAll = events.statusVideos.filter((e) => e.status === "APPROVED");
  const approvedMatch = countMatched(approvedAll, (e) => matches(e.email, e.passportNumber));

  return {
    approvedVideoCount: statusVideos.filter((e) => e.status === "APPROVED").length,
    deniedVideoCount: statusVideos.filter((e) => e.status === "DENIED").length,
    approvedApplicantCount: inHousePassed.length,
    deniedApplicantCount: deniedApplicants.length,
    erroredVideoAttemptCount: failureReasonBreakdown.reduce((s, r) => s + r.count, 0),
    failureReasonBreakdown,
    deniedPassportRows: filteredDeniedRows,
    routeFilterCoverage: {
      approvedVideosMatched: approvedMatch.matched,
      approvedVideosTotal: approvedMatch.total,
      unmatchedOnDashboard: approvedMatch.total - approvedMatch.matched,
    },
  };
}
