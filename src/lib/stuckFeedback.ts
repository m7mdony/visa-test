import type { LogEntry } from "@/lib/grafanaLoki";

export type StuckFeedbackEpisode = {
  jobId: string;
  sessionPrefix: string;
  clip: string;
  passportNumber: string | null;
  videoUrl: string | null;
  startedAt: string;
  endedAt: string | null;
  maxElapsedMs: number;
  instruction: string | null;
  startLine: string;
  stopLine: string | null;
};

export type StuckFeedbackBuildResult = {
  clipCounts: Record<string, number>;
  episodes: StuckFeedbackEpisode[];
};

const STUCK_RE = /\[STUCK-FEEDBACK\]/i;

export function extractJobIdFromLine(line: string): string | null {
  const m = line.match(/\[JOB_ID:([^\]]+)\]/i);
  return m?.[1]?.trim() ?? null;
}

export function extractPassportFromJobId(jobId: string): string | null {
  const pipe = jobId.indexOf("|");
  if (pipe <= 0) return null;
  const passport = jobId.slice(0, pipe).trim();
  if (!passport || passport === "VERIFICATION") return null;
  if (/^[a-f0-9-]{8,}$/i.test(passport)) return null;
  return passport;
}

export function sessionPrefixFromJobId(jobId: string): string {
  const pipe = jobId.indexOf("|");
  const id = pipe > 0 ? jobId.slice(pipe + 1) : jobId;
  const first = id.split("-")[0]?.trim().toLowerCase();
  return first || id.toLowerCase();
}

function parseStuckStartClip(line: string): string | null {
  const m = line.match(/clip\s+'([^']+)'\s*>\d+ms/i);
  return m?.[1]?.trim() ?? null;
}

function parseStuckElapsedClip(line: string): { clip: string; elapsedMs: number; instruction: string | null } | null {
  const m = line.match(/clip='([^']+)'\s+elapsed=(\d+)ms(?:\s+instruction="([^"]*)")?/i);
  if (!m?.[1] || !m[2]) return null;
  return {
    clip: m[1].trim(),
    elapsedMs: parseInt(m[2], 10),
    instruction: m[3]?.trim() ?? null,
  };
}

function parseStuckStopClip(line: string): string | null {
  const m = line.match(/stopped\s+clip='([^']+)'/i);
  return m?.[1]?.trim() ?? null;
}

type JobMeta = {
  passportNumber: string | null;
  videoUrl: string | null;
};

function parseRedisPayloadLine(line: string): { sessionPrefix: string; passportNumber: string | null; videoUrl: string | null } | null {
  if (!line.includes("[REDIS][PAYLOAD]")) return null;
  const payloadMatch = line.match(/payload=(\{.+\})\s*$/);
  if (!payloadMatch?.[1]) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadMatch[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const sessionId =
    typeof payload.sessionId === "string" && payload.sessionId.trim()
      ? payload.sessionId.trim()
      : typeof payload.id === "string" && payload.id.trim()
        ? payload.id.trim()
        : "";
  if (!sessionId) return null;
  const passportNumber =
    typeof payload.passportNumber === "string" && payload.passportNumber.trim()
      ? payload.passportNumber.trim()
      : null;
  const videoUrl =
    typeof payload.videoUrl === "string" && payload.videoUrl.trim() ? payload.videoUrl.trim() : null;
  return {
    sessionPrefix: sessionPrefixFromJobId(sessionId),
    passportNumber,
    videoUrl,
  };
}

function parseSolvingFaceLine(line: string): { sessionPrefix: string; passportNumber: string | null } | null {
  if (!/Solving face verification for session/i.test(line)) return null;
  const m = line.match(/for session\s+([a-f0-9]+)\s*\(\s*passport:\s*([^)]+?)\s*\)/i);
  if (!m?.[1]) return null;
  const passport = m[2]?.trim();
  return {
    sessionPrefix: m[1].trim().toLowerCase(),
    passportNumber: passport && passport !== "VERIFICATION" ? passport : null,
  };
}

function parseJobReceivedLine(line: string): { sessionPrefix: string; passportNumber: string | null } | null {
  if (!/\[REDIS\]\s*Job received:/i.test(line)) return null;
  const sessionM = line.match(/sessionId=([a-f0-9-]+)/i);
  const passportM = line.match(/passport=([^\s]+)/i);
  if (!sessionM?.[1]) return null;
  const passport = passportM?.[1]?.trim();
  return {
    sessionPrefix: sessionPrefixFromJobId(sessionM[1]),
    passportNumber: passport && passport !== "VERIFICATION" && passport !== "—" ? passport : null,
  };
}

export function buildJobMetaMap(enrichmentLogs: LogEntry[]): Map<string, JobMeta> {
  const byPrefix = new Map<string, JobMeta>();

  const sorted = [...enrichmentLogs].sort((a, b) => a.time.localeCompare(b.time));
  for (const entry of sorted) {
    const payload = parseRedisPayloadLine(entry.line);
    if (payload) {
      const prev = byPrefix.get(payload.sessionPrefix) ?? { passportNumber: null, videoUrl: null };
      byPrefix.set(payload.sessionPrefix, {
        passportNumber: payload.passportNumber ?? prev.passportNumber,
        videoUrl: payload.videoUrl ?? prev.videoUrl,
      });
    }
    const solving = parseSolvingFaceLine(entry.line);
    if (solving) {
      const prev = byPrefix.get(solving.sessionPrefix) ?? { passportNumber: null, videoUrl: null };
      byPrefix.set(solving.sessionPrefix, {
        passportNumber: solving.passportNumber ?? prev.passportNumber,
        videoUrl: prev.videoUrl,
      });
    }
    const received = parseJobReceivedLine(entry.line);
    if (received) {
      const prev = byPrefix.get(received.sessionPrefix) ?? { passportNumber: null, videoUrl: null };
      byPrefix.set(received.sessionPrefix, {
        passportNumber: received.passportNumber ?? prev.passportNumber,
        videoUrl: prev.videoUrl,
      });
    }
  }

  return byPrefix;
}

function resolveJobMeta(jobId: string, byPrefix: Map<string, JobMeta>): JobMeta {
  const fromJobId = extractPassportFromJobId(jobId);
  const prefix = sessionPrefixFromJobId(jobId);
  const meta = byPrefix.get(prefix);
  return {
    passportNumber: fromJobId ?? meta?.passportNumber ?? null,
    videoUrl: meta?.videoUrl ?? null,
  };
}

type OpenEpisode = {
  jobId: string;
  clip: string;
  startedAt: string;
  maxElapsedMs: number;
  instruction: string | null;
  startLine: string;
};

export function buildStuckFeedbackReport(params: {
  stuckLogs: LogEntry[];
  enrichmentLogs: LogEntry[];
}): StuckFeedbackBuildResult {
  const { stuckLogs, enrichmentLogs } = params;
  const byPrefix = buildJobMetaMap(enrichmentLogs);
  const sorted = [...stuckLogs]
    .filter((e) => STUCK_RE.test(e.line))
    .sort((a, b) => a.time.localeCompare(b.time));

  const open = new Map<string, OpenEpisode>();
  const episodes: StuckFeedbackEpisode[] = [];
  let lastJobId: string | null = null;

  function episodeKey(jobId: string, clip: string): string {
    return `${jobId}|${clip}`;
  }

  function closeEpisode(key: string, endedAt: string, stopLine: string | null) {
    const ep = open.get(key);
    if (!ep) return;
    open.delete(key);
    const meta = resolveJobMeta(ep.jobId, byPrefix);
    episodes.push({
      jobId: ep.jobId,
      sessionPrefix: sessionPrefixFromJobId(ep.jobId),
      clip: ep.clip,
      passportNumber: meta.passportNumber,
      videoUrl: meta.videoUrl,
      startedAt: ep.startedAt,
      endedAt,
      maxElapsedMs: ep.maxElapsedMs,
      instruction: ep.instruction,
      startLine: ep.startLine,
      stopLine,
    });
  }

  for (const entry of sorted) {
    const jobFromLine = extractJobIdFromLine(entry.line);
    if (jobFromLine) lastJobId = jobFromLine;

    const stopClip = parseStuckStopClip(entry.line);
    if (stopClip) {
      if (jobFromLine) {
        closeEpisode(episodeKey(jobFromLine, stopClip), entry.time, entry.line);
      } else {
        for (const [key, ep] of [...open.entries()]) {
          if (ep.clip === stopClip) closeEpisode(key, entry.time, entry.line);
        }
      }
      continue;
    }

    const startClip = parseStuckStartClip(entry.line);
    if (startClip && jobFromLine) {
      const key = episodeKey(jobFromLine, startClip);
      if (!open.has(key)) {
        open.set(key, {
          jobId: jobFromLine,
          clip: startClip,
          startedAt: entry.time,
          maxElapsedMs: 2000,
          instruction: null,
          startLine: entry.line,
        });
      }
      continue;
    }

    const elapsed = parseStuckElapsedClip(entry.line);
    if (!elapsed) continue;

    const jobId = jobFromLine ?? lastJobId;
    if (!jobId) continue;

    const key = episodeKey(jobId, elapsed.clip);
    const existing = open.get(key);
    if (existing) {
      existing.maxElapsedMs = Math.max(existing.maxElapsedMs, elapsed.elapsedMs);
      if (elapsed.instruction) existing.instruction = elapsed.instruction;
    } else {
      open.set(key, {
        jobId,
        clip: elapsed.clip,
        startedAt: entry.time,
        maxElapsedMs: elapsed.elapsedMs,
        instruction: elapsed.instruction,
        startLine: entry.line,
      });
    }
  }

  for (const [key, ep] of open.entries()) {
    const meta = resolveJobMeta(ep.jobId, byPrefix);
    episodes.push({
      jobId: ep.jobId,
      sessionPrefix: sessionPrefixFromJobId(ep.jobId),
      clip: ep.clip,
      passportNumber: meta.passportNumber,
      videoUrl: meta.videoUrl,
      startedAt: ep.startedAt,
      endedAt: null,
      maxElapsedMs: ep.maxElapsedMs,
      instruction: ep.instruction,
      startLine: ep.startLine,
      stopLine: null,
    });
    open.delete(key);
  }

  episodes.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const clipCounts: Record<string, number> = {};
  for (const ep of episodes) {
    clipCounts[ep.clip] = (clipCounts[ep.clip] ?? 0) + 1;
  }

  return { clipCounts, episodes };
}
