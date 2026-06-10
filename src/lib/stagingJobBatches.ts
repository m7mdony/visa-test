import type { DeniedPassportRow } from "@/lib/deniedPassports";
import type { DeniedEmailRecovery } from "@/lib/deniedRecovery";

export const STAGING_JOBS_BATCH_SIZE = 20;

/** Same shape as `azure-liveness-automation/parrallel-test-session.js` JOBS entries. */
export type StagingJobExport = {
  label: string;
  passportURL: string;
  videoUrl: string;
};

export type StagingJob = StagingJobExport & {
  email: string;
  passportNumber: string;
};

export type StagingJobBatch = {
  batch: number;
  count: number;
  jobs: StagingJobExport[];
};

export type DashboardMediaEntry = {
  passportImages?: Array<{ url: string }>;
  videos?: string[];
  error?: string;
};

export type SkippedApplicant = {
  email: string;
  passportNumber: string | null;
  reason: string;
};

export function emailsNotRecoveredAfterDenied(
  recoveryByEmail: Record<string, DeniedEmailRecovery>
): string[] {
  return Object.values(recoveryByEmail)
    .filter((r) => !r.recoveredAfterLatestDenied)
    .map((r) => r.email)
    .sort((a, b) => a.localeCompare(b));
}

export function buildNotRecoveredStagingJobs(params: {
  deniedRows: DeniedPassportRow[];
  recoveryByEmail: Record<string, DeniedEmailRecovery>;
  dashByPassport: Record<string, DashboardMediaEntry>;
}): {
  jobs: StagingJob[];
  skipped: SkippedApplicant[];
  notRecoveredEmails: string[];
} {
  const { deniedRows, recoveryByEmail, dashByPassport } = params;
  const notRecoveredEmails = emailsNotRecoveredAfterDenied(recoveryByEmail);
  const notRecoveredSet = new Set(notRecoveredEmails);
  const jobs: StagingJob[] = [];
  const skipped: SkippedApplicant[] = [];
  const seenJob = new Set<string>();

  const passportsByEmail = new Map<string, Set<string>>();
  for (const row of deniedRows) {
    const em = row.email.trim().toLowerCase();
    if (!notRecoveredSet.has(em)) continue;
    const pn = row.passportNumber?.trim();
    if (!pn) continue;
    let set = passportsByEmail.get(em);
    if (!set) {
      set = new Set();
      passportsByEmail.set(em, set);
    }
    set.add(pn);
  }

  for (const email of notRecoveredEmails) {
    const passports = passportsByEmail.get(email);
    if (!passports || passports.size === 0) {
      skipped.push({ email, passportNumber: null, reason: "No passport number in Loki for this email" });
      continue;
    }
    for (const passportNumber of [...passports].sort()) {
      const dash = dashByPassport[passportNumber];
      if (!dash) {
        skipped.push({ email, passportNumber, reason: "Passport not loaded from dashboard (sign in / run again)" });
        continue;
      }
      if (dash.error) {
        skipped.push({ email, passportNumber, reason: dash.error });
        continue;
      }
      const passportURL = dash.passportImages?.find((p) => p.url?.trim())?.url?.trim() ?? "";
      if (!passportURL) {
        skipped.push({ email, passportNumber, reason: "No passport image on dashboard" });
        continue;
      }
      const videos = (dash.videos ?? []).map((v) => v.trim()).filter(Boolean);
      if (videos.length === 0) {
        skipped.push({ email, passportNumber, reason: "No applicant videos on dashboard" });
        continue;
      }
      const label = passportNumber;
      for (const videoUrl of videos) {
        const key = `${label}|${passportURL}|${videoUrl}`;
        if (seenJob.has(key)) continue;
        seenJob.add(key);
        jobs.push({ label, passportURL, videoUrl, email, passportNumber });
      }
    }
  }

  jobs.sort(
    (a, b) =>
      a.passportNumber.localeCompare(b.passportNumber) || a.videoUrl.localeCompare(b.videoUrl)
  );
  return { jobs, skipped, notRecoveredEmails };
}

/** One passport → all dashboard videos mapped to `{ label, passportURL, videoUrl }`. */
export function buildStagingJobsForPassport(
  passportNumber: string,
  entry: DashboardMediaEntry | undefined
): { jobs: StagingJobExport[]; error: string | null } {
  const pn = passportNumber?.trim();
  if (!pn) return { jobs: [], error: "No passport number" };
  if (!entry) return { jobs: [], error: "Load dashboard data first" };
  if (entry.error) return { jobs: [], error: entry.error };
  const passportURL = entry.passportImages?.find((p) => p.url?.trim())?.url?.trim() ?? "";
  if (!passportURL) return { jobs: [], error: "No passport image on dashboard" };
  const videos = (entry.videos ?? []).map((v) => v.trim()).filter(Boolean);
  if (videos.length === 0) return { jobs: [], error: "No videos on dashboard" };
  const jobs = videos.map((videoUrl) => ({
    label: pn,
    passportURL,
    videoUrl,
  }));
  return { jobs, error: null };
}

export function buildStagingJobsForAllPassports(
  dashByPassport: Record<string, DashboardMediaEntry>
): StagingJobExport[] {
  const jobs: StagingJobExport[] = [];
  const seen = new Set<string>();
  for (const pn of Object.keys(dashByPassport).sort()) {
    const { jobs: rowJobs } = buildStagingJobsForPassport(pn, dashByPassport[pn]);
    for (const j of rowJobs) {
      const key = `${j.label}|${j.passportURL}|${j.videoUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(j);
    }
  }
  return jobs;
}

export function chunkStagingJobs(jobs: StagingJob[], batchSize = STAGING_JOBS_BATCH_SIZE): StagingJobBatch[] {
  const exportJobs: StagingJobExport[] = jobs.map(({ label, passportURL, videoUrl }) => ({
    label,
    passportURL,
    videoUrl,
  }));
  const batches: StagingJobBatch[] = [];
  for (let i = 0; i < exportJobs.length; i += batchSize) {
    const slice = exportJobs.slice(i, i + batchSize);
    batches.push({ batch: batches.length + 1, count: slice.length, jobs: slice });
  }
  return batches;
}
