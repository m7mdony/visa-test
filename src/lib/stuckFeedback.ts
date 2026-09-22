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

/** JOB_ID tag is passport, or `passport|redis_message_id` (see solver `logger.py`). */
export function extractPassportFromJobId(jobId: string): string | null {
  const raw = jobId.trim();
  if (!raw) return null;
  const pipe = raw.indexOf("|");
  const passport = (pipe > 0 ? raw.slice(0, pipe) : raw).trim();
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

export type JobMeta = {
  passportNumber: string | null;
  videoUrl: string | null;
  /** Reserved — Redis `payload.id` is client correlation id, not dashboard applicant uuid. */
  applicantId: string | null;
  messageId: string | null;
  sessionPrefix: string | null;
};

/** `[JOB_ID:passport|redis_message_id]` — second part is Redis stream message id, not Azure sessionId. */
export function extractMessageIdFromJobId(jobId: string): string | null {
  const pipe = jobId.indexOf("|");
  if (pipe <= 0) return null;
  const messageId = jobId.slice(pipe + 1).trim();
  return messageId || null;
}

function parseRedisPayloadLine(line: string): JobMeta | null {
  if (!line.includes("[REDIS][PAYLOAD]")) return null;
  const messageIdM = line.match(/message_id=([^\s]+)/i);
  const messageId = messageIdM?.[1]?.trim() ?? null;
  const payloadMatch = line.match(/payload=(\{.+\})\s*$/);
  if (!payloadMatch?.[1]) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadMatch[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const sessionId =
    typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId.trim() : "";
  // payload.id is Redis client correlation id (sessionId-suffix), NOT dashboard applicant uuid
  const applicantId = null;
  const passportNumber =
    typeof payload.passportNumber === "string" && payload.passportNumber.trim()
      ? payload.passportNumber.trim()
      : null;
  const videoUrl =
    typeof payload.videoUrl === "string" && payload.videoUrl.trim() ? payload.videoUrl.trim() : null;
  if (!messageId && !sessionId && !applicantId) return null;
  return {
    messageId,
    sessionPrefix: sessionId ? sessionPrefixFromJobId(sessionId) : null,
    applicantId,
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

export function episodeKey(jobId: string, clip: string, startedAt: string): string {
  return `${jobId}|${clip}|${startedAt}`;
}

const EMPTY_META: JobMeta = {
  passportNumber: null,
  videoUrl: null,
  applicantId: null,
  messageId: null,
  sessionPrefix: null,
};

function mergeMeta(prev: JobMeta, next: Partial<JobMeta>): JobMeta {
  return {
    passportNumber: next.passportNumber ?? prev.passportNumber,
    videoUrl: next.videoUrl ?? prev.videoUrl,
    applicantId: next.applicantId ?? prev.applicantId,
    messageId: next.messageId ?? prev.messageId,
    sessionPrefix: next.sessionPrefix ?? prev.sessionPrefix,
  };
}

export function resolvePassportForJob(
  jobId: string,
  fromJobIdPassport: string | null,
  byMessageId: Map<string, JobMeta>,
  bySessionPrefix: Map<string, JobMeta>,
): string | null {
  const meta = resolveJobMetaForDashboard(jobId, fromJobIdPassport, byMessageId, bySessionPrefix);
  return meta.passportNumber?.trim() ?? null;
}

/** Resolve dashboard applicant id + passport for a solver JOB_ID tag. */
export function resolveJobMetaForDashboard(
  jobId: string,
  fromJobIdPassport: string | null,
  byMessageId: Map<string, JobMeta>,
  bySessionPrefix: Map<string, JobMeta>,
): JobMeta {
  const messageId = extractMessageIdFromJobId(jobId);
  if (messageId && byMessageId.has(messageId)) {
    return mergeMeta(EMPTY_META, byMessageId.get(messageId)!);
  }
  if (messageId) {
    const msgPrefix = sessionPrefixFromJobId(messageId);
    if (bySessionPrefix.has(msgPrefix)) {
      return mergeMeta(EMPTY_META, bySessionPrefix.get(msgPrefix)!);
    }
  }
  const azurePrefix = sessionPrefixFromJobId(jobId);
  if (bySessionPrefix.has(azurePrefix)) {
    return mergeMeta(EMPTY_META, bySessionPrefix.get(azurePrefix)!);
  }
  return mergeMeta(EMPTY_META, {
    passportNumber: fromJobIdPassport?.trim() ?? extractPassportFromJobId(jobId),
  });
}

export function buildJobMetaMaps(enrichmentLogs: LogEntry[]): {
  byMessageId: Map<string, JobMeta>;
  bySessionPrefix: Map<string, JobMeta>;
} {
  const byMessageId = new Map<string, JobMeta>();
  const bySessionPrefix = new Map<string, JobMeta>();

  const sorted = [...enrichmentLogs].sort((a, b) => a.time.localeCompare(b.time));
  for (const entry of sorted) {
    const payload = parseRedisPayloadLine(entry.line);
    if (payload) {
      if (payload.messageId) {
        byMessageId.set(
          payload.messageId,
          mergeMeta(byMessageId.get(payload.messageId) ?? EMPTY_META, payload),
        );
      }
      if (payload.sessionPrefix) {
        bySessionPrefix.set(
          payload.sessionPrefix,
          mergeMeta(bySessionPrefix.get(payload.sessionPrefix) ?? EMPTY_META, payload),
        );
      }
    }
    const solving = parseSolvingFaceLine(entry.line);
    if (solving) {
      bySessionPrefix.set(
        solving.sessionPrefix,
        mergeMeta(bySessionPrefix.get(solving.sessionPrefix) ?? EMPTY_META, {
          passportNumber: solving.passportNumber,
          sessionPrefix: solving.sessionPrefix,
        }),
      );
    }
    const received = parseJobReceivedLine(entry.line);
    if (received) {
      bySessionPrefix.set(
        received.sessionPrefix,
        mergeMeta(bySessionPrefix.get(received.sessionPrefix) ?? EMPTY_META, {
          passportNumber: received.passportNumber,
          sessionPrefix: received.sessionPrefix,
        }),
      );
    }
  }

  return { byMessageId, bySessionPrefix };
}

/** @deprecated use buildJobMetaMaps */
export function buildJobMetaMap(enrichmentLogs: LogEntry[]): Map<string, JobMeta> {
  return buildJobMetaMaps(enrichmentLogs).bySessionPrefix;
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
  const { byMessageId, bySessionPrefix } = buildJobMetaMaps(enrichmentLogs);
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
    const meta = resolveJobMetaForDashboard(
      ep.jobId,
      extractPassportFromJobId(ep.jobId),
      byMessageId,
      bySessionPrefix,
    );
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
    const meta = resolveJobMetaForDashboard(
      ep.jobId,
      extractPassportFromJobId(ep.jobId),
      byMessageId,
      bySessionPrefix,
    );
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
