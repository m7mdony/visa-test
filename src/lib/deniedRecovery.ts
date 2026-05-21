import type { EmailStatEvent, StatusVideoEvent } from "@/lib/reportEvents";

export type DeniedEmailRecovery = {
  email: string;
  deniedEventCount: number;
  latestDeniedAt: string | null;
  /** True if any in-house verification passed after the latest DENIED idnfystatus for this email. */
  recoveredAfterLatestDenied: boolean;
  recoveredAt: string | null;
  /** Denied events that were followed by at least one in-house pass (same email, later time). */
  deniedEventsRecovered: number;
};

function timesForEmail(events: Array<{ email: string; at: string }>): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const e of events) {
    const em = e.email?.trim().toLowerCase();
    if (!em || !em.includes("@")) continue;
    const t = Date.parse(e.at);
    if (!Number.isFinite(t)) continue;
    const arr = m.get(em) ?? [];
    arr.push(t);
    m.set(em, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => a - b);
  return m;
}

/**
 * For each email with DENIED idnfystatus in the window, check whether
 * `In-house verification passed` occurred later for the same email.
 */
export function computeDeniedRecoveryByEmail(
  statusVideos: StatusVideoEvent[],
  inHousePassed: EmailStatEvent[]
): Record<string, DeniedEmailRecovery> {
  const deniedVideos = statusVideos.filter((e) => e.status === "DENIED");
  const deniedByEmail = timesForEmail(deniedVideos);
  const passByEmail = timesForEmail(inHousePassed);
  const out: Record<string, DeniedEmailRecovery> = {};

  for (const [email, deniedTimes] of deniedByEmail) {
    const passTimes = passByEmail.get(email) ?? [];
    let deniedEventsRecovered = 0;
    for (const dMs of deniedTimes) {
      if (passTimes.some((pMs) => pMs > dMs)) deniedEventsRecovered += 1;
    }
    const latestDeniedMs = deniedTimes[deniedTimes.length - 1]!;
    let recoveredAfterLatestDenied = false;
    let recoveredAt: string | null = null;
    for (const pMs of passTimes) {
      if (pMs > latestDeniedMs) {
        recoveredAfterLatestDenied = true;
        recoveredAt = new Date(pMs).toISOString();
        break;
      }
    }
    out[email] = {
      email,
      deniedEventCount: deniedTimes.length,
      latestDeniedAt: new Date(latestDeniedMs).toISOString(),
      recoveredAfterLatestDenied,
      recoveredAt,
      deniedEventsRecovered,
    };
  }
  return out;
}
