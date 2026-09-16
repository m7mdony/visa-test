export type LogEntry = { time: string; line: string };

export type SolverAttempt = {
  attempt: number;
  success: boolean;
  recordedVideoUrl: string | null;
  at: string;
  resultId: string;
};

export type InHouseVerVideoRow = {
  email: string;
  passportNumber: string | null;
  urn: string | null;
  fromCountry: string | null;
  toCountry: string | null;
  passedAt: string;
  passedLine: string;
  token: string | null;
  activatedAt: string | null;
  activationLine: string | null;
  solves: SolverAttempt[];
  unresolvedReason?: string;
};

export function extractLogField(line: string, key: string): string | undefined {
  const r = new RegExp(`${key}=([^\\s,\\]]+)`, "i");
  const m = line.match(r);
  return m?.[1]?.trim();
}

export function extractEmailFromLine(line: string): string | null {
  const emailEq = extractLogField(line, "email");
  if (emailEq?.includes("@")) return emailEq.toLowerCase();
  const generic = line.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return generic?.[0]?.trim().toLowerCase() ?? null;
}

export function extractUrnFromLine(line: string): string | null {
  const urn = extractLogField(line, "urn");
  return urn ? urn.toLowerCase() : null;
}

export function isInHouseVerificationPassedLine(line: string): boolean {
  return /in-house verification passed\b/i.test(line);
}

export function extractActivatedReferenceNumber(line: string): string | null {
  const m = line.match(/\[ReferenceNumber:\s*([a-f0-9-]+)\]/i);
  const ref = m?.[1]?.trim().toLowerCase();
  return ref && ref.length > 0 ? ref : null;
}

export function isActivationLine(line: string): boolean {
  return (
    /Activated in-house identity verification token/i.test(line) &&
    /\[ReferenceNumber:/i.test(line)
  );
}

export type ParsedPublishedResult = {
  resultId: string;
  token: string;
  success: boolean;
  recordedVideoUrl: string | null;
};

/** `[REDIS] Published result: {token}-{suffix} success=True recordedVideoUrl=https://…` */
export function parsePublishedResultLine(line: string): ParsedPublishedResult | null {
  if (!/\[REDIS\]\s*Published result:/i.test(line)) return null;
  const m = line.match(/Published result:\s*(\S+)\s+success=(True|False)/i);
  if (!m?.[1]) return null;
  const resultId = m[1].trim();
  const token = resultId.split("-").slice(0, 5).join("-").toLowerCase();
  if (!/^[a-f0-9-]{36}$/.test(token)) return null;
  const urlM = line.match(/recordedVideoUrl=([^\s]+)/i);
  let url = urlM?.[1]?.trim() ?? null;
  if (url === "—" || url === "-" || url === "null" || url === "None") url = null;
  return {
    resultId,
    token,
    success: m[2].toLowerCase() === "true",
    recordedVideoUrl: url,
  };
}

function findActivationForPass(
  passEntry: LogEntry,
  activationLogs: LogEntry[],
  email: string
): LogEntry | null {
  const passMs = Date.parse(passEntry.time);
  if (!Number.isFinite(passMs)) return null;
  const passUrn = extractUrnFromLine(passEntry.line);

  const candidates = activationLogs.filter((entry) => {
    if (!isActivationLine(entry.line)) return false;
    const em = extractEmailFromLine(entry.line);
    if (em !== email) return false;
    const t = Date.parse(entry.time);
    if (!Number.isFinite(t) || t > passMs) return false;
    if (passUrn) {
      const urn = extractUrnFromLine(entry.line);
      if (urn && urn !== passUrn) return false;
    }
    return true;
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.time.localeCompare(a.time));
  return candidates[0];
}

function collectSolverAttemptsForToken(
  token: string,
  solverLogs: LogEntry[],
  activationMs: number,
  passMs: number
): SolverAttempt[] {
  const padStart = activationMs - 2 * 60 * 1000;
  const padEnd = passMs + 30 * 60 * 1000;
  const withTime: Array<{ t: number; parsed: ParsedPublishedResult; at: string }> = [];

  for (const entry of solverLogs) {
    const parsed = parsePublishedResultLine(entry.line);
    if (!parsed || parsed.token !== token) continue;
    const t = Date.parse(entry.time);
    if (!Number.isFinite(t) || t < padStart || t > padEnd) continue;
    withTime.push({ t, parsed, at: entry.time });
  }

  withTime.sort((a, b) => a.t - b.t);
  return withTime.slice(0, 3).map((item, idx) => ({
    attempt: idx + 1,
    success: item.parsed.success,
    recordedVideoUrl: item.parsed.recordedVideoUrl,
    at: item.at,
    resultId: item.parsed.resultId,
  }));
}

export function buildInHouseVerVideoRows(params: {
  passedLogs: LogEntry[];
  activationLogs: LogEntry[];
  solverLogs: LogEntry[];
}): InHouseVerVideoRow[] {
  const { passedLogs, activationLogs, solverLogs } = params;
  const rows: InHouseVerVideoRow[] = [];

  const passed = passedLogs
    .filter((e) => isInHouseVerificationPassedLine(e.line))
    .sort((a, b) => a.time.localeCompare(b.time));

  for (const passEntry of passed) {
    const email = extractEmailFromLine(passEntry.line);
    if (!email) continue;

    const activation = findActivationForPass(passEntry, activationLogs, email);
    const token = activation ? extractActivatedReferenceNumber(activation.line) : null;
    const passMs = Date.parse(passEntry.time);
    const activationMs = activation ? Date.parse(activation.time) : passMs;

    let solves: SolverAttempt[] = [];
    let unresolvedReason: string | undefined;

    if (!activation) {
      unresolvedReason = "No activation token found for this email before pass";
    } else if (!token) {
      unresolvedReason = "Activation line missing ReferenceNumber";
    } else {
      solves = collectSolverAttemptsForToken(token, solverLogs, activationMs, passMs);
      if (solves.length === 0) {
        unresolvedReason = "No solver Published result lines for token";
      }
    }

    rows.push({
      email,
      passportNumber:
        extractLogField(passEntry.line, "passportNumber") ??
        extractLogField(passEntry.line, "PassportNumber") ??
        (activation
          ? extractLogField(activation.line, "passportNumber") ??
            extractLogField(activation.line, "PassportNumber") ??
            null
          : null),
      urn: extractUrnFromLine(passEntry.line),
      fromCountry: extractLogField(passEntry.line, "fromCountry") ?? null,
      toCountry: extractLogField(passEntry.line, "toCountry") ?? null,
      passedAt: passEntry.time,
      passedLine: passEntry.line,
      token,
      activatedAt: activation?.time ?? null,
      activationLine: activation?.line ?? null,
      solves,
      unresolvedReason,
    });
  }

  return rows;
}
