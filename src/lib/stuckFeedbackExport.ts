import { episodeKey, extractPassportFromJobId, type StuckFeedbackEpisode } from "@/lib/stuckFeedback";

export type StuckEpisodeExportRow = {
  startedAt: string;
  endedAt: string;
  clip: string;
  maxElapsedMs: number;
  instruction: string;
  passportNumber: string;
  applicantId: string;
  passportImageUrl: string;
  gestureClipUrl: string;
  dashboardError: string;
  jobId: string;
  videoUrl: string;
  open: boolean;
};

export type StuckFeedbackExportPayload = {
  exportedAt: string;
  from: number;
  to: number;
  deploymentEnv: string;
  solverApp: string;
  totals: {
    stuckQueryLines: number;
    episodeCount: number;
    distinctClips: number;
    withPassport: number;
  };
  clipCounts: Record<string, number>;
  episodes: StuckEpisodeExportRow[];
};

type DashboardRow = {
  passportNumber: string | null;
  applicantId: string | null;
  passportImageUrl: string | null;
  gestureClipUrl: string | null;
  error?: string;
};

function csvCell(v: string | number | boolean): string {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function stampForFilename(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}-${h}${min}`;
}

export function buildStuckFeedbackExportRows(
  episodes: StuckFeedbackEpisode[],
  byEpisode: Record<string, DashboardRow>,
): StuckEpisodeExportRow[] {
  return episodes.map((ep) => {
    const key = episodeKey(ep.jobId, ep.clip, ep.startedAt);
    const dash = byEpisode[key];
    const passport =
      dash?.passportNumber?.trim() ||
      ep.passportNumber?.trim() ||
      extractPassportFromJobId(ep.jobId) ||
      "";
    return {
      startedAt: ep.startedAt,
      endedAt: ep.endedAt ?? "",
      clip: ep.clip,
      maxElapsedMs: ep.maxElapsedMs,
      instruction: ep.instruction ?? "",
      passportNumber: passport,
      applicantId: dash?.applicantId ?? "",
      passportImageUrl: dash?.passportImageUrl ?? "",
      gestureClipUrl: dash?.gestureClipUrl ?? "",
      dashboardError: dash?.error ?? "",
      jobId: ep.jobId,
      videoUrl: ep.videoUrl ?? "",
      open: !ep.endedAt,
    };
  });
}

export function buildStuckFeedbackExportPayload(params: {
  from: number;
  to: number;
  deploymentEnv: string;
  solverApp: string;
  totals: StuckFeedbackExportPayload["totals"];
  clipCounts: Record<string, number>;
  episodes: StuckFeedbackEpisode[];
  byEpisode: Record<string, DashboardRow>;
}): StuckFeedbackExportPayload {
  return {
    exportedAt: new Date().toISOString(),
    from: params.from,
    to: params.to,
    deploymentEnv: params.deploymentEnv,
    solverApp: params.solverApp,
    totals: params.totals,
    clipCounts: params.clipCounts,
    episodes: buildStuckFeedbackExportRows(params.episodes, params.byEpisode),
  };
}

const CSV_HEADERS: (keyof StuckEpisodeExportRow)[] = [
  "startedAt",
  "endedAt",
  "clip",
  "maxElapsedMs",
  "instruction",
  "passportNumber",
  "applicantId",
  "passportImageUrl",
  "gestureClipUrl",
  "dashboardError",
  "jobId",
  "videoUrl",
  "open",
];

export function stuckFeedbackToCsv(payload: StuckFeedbackExportPayload): string {
  const meta = [
    `# stuck-feedback export ${payload.exportedAt}`,
    `# env=${payload.deploymentEnv} solver=${payload.solverApp}`,
    `# from=${new Date(payload.from).toISOString()} to=${new Date(payload.to).toISOString()}`,
    `# episodes=${payload.totals.episodeCount} clipCounts=${JSON.stringify(payload.clipCounts)}`,
    CSV_HEADERS.join(","),
  ];
  const rows = payload.episodes.map((ep) =>
    CSV_HEADERS.map((h) => csvCell(ep[h])).join(","),
  );
  return [...meta, ...rows].join("\n");
}

export function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function exportStuckFeedbackCsv(payload: StuckFeedbackExportPayload): void {
  downloadTextFile(
    `stuck-feedback-${stampForFilename()}.csv`,
    stuckFeedbackToCsv(payload),
    "text/csv;charset=utf-8",
  );
}

export function exportStuckFeedbackJson(payload: StuckFeedbackExportPayload): void {
  downloadTextFile(
    `stuck-feedback-${stampForFilename()}.json`,
    JSON.stringify(payload, null, 2),
    "application/json;charset=utf-8",
  );
}
