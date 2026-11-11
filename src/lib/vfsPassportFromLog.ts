export type VfsUploadRequestBody = {
  loginUser?: string;
  missionCode?: string;
  countryCode?: string;
  centerCode?: string;
  visaCategoryCode?: string;
  fileBytes?: string;
  selfiImageFileBytes?: string;
};

export type ParsedVfsPassportFromLog = {
  body: VfsUploadRequestBody;
  passportNumberFromTail: string | null;
  imageField: "fileBytes" | "selfiImageFileBytes";
  imageDataUrl: string;
  decodedSizeBytes: number;
  /** e.g. UploadApplicantDocument Request line */
  matchedFrom: string;
};

export function extractPassportNumberFromLogTail(text: string): string | null {
  const matches = [...text.matchAll(/\spassportNumber=([^\s]+)/gi)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1].trim();
}

/** Grafana-style exports: skip timestamp-only rows. */
function logicalLogLines(raw: string): string[] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    const tsOnly =
      /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(line) &&
      !/\b(debug|info|warn|error):/i.test(line) &&
      line.length < 40;
    if (tsOnly) continue;
    out.push(line);
  }
  return out;
}

function stripLogTail(text: string): string {
  let s = text;
  s = s.replace(/\spassportNumber=[^\s]+/i, "").trim();
  const emailIdx = s.search(/\semail=/i);
  if (emailIdx >= 0) s = s.slice(0, emailIdx).trim();
  return s;
}

function extractBalancedJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseQuotedRequestBody(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed.startsWith('"')) return null;
  try {
    const inner = JSON.parse(trimmed) as unknown;
    if (typeof inner === "string" && inner.trim().startsWith("{")) return inner.trim();
  } catch {
    /* ignore */
  }
  return null;
}

function extractJsonFromFragment(fragment: string): string | null {
  const text = stripLogTail(fragment);

  for (const marker of ["Request:", "Request body:"]) {
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const idx = text.indexOf(marker, searchFrom);
      if (idx < 0) break;
      let payload = text.slice(idx + marker.length).trim();
      payload = stripLogTail(payload);

      const quoted = parseQuotedRequestBody(payload);
      if (quoted) return quoted;

      const balanced = extractBalancedJsonObject(payload);
      if (balanced) return balanced;

      searchFrom = idx + marker.length;
    }
  }

  if (text.trim().startsWith("{")) {
    return extractBalancedJsonObject(text) ?? text.trim();
  }

  return null;
}

type JsonHit = {
  json: string;
  score: number;
  from: string;
};

function scoreFragment(fragment: string, json: string): JsonHit | null {
  let body: VfsUploadRequestBody;
  try {
    body = JSON.parse(json) as VfsUploadRequestBody;
  } catch {
    return null;
  }
  if (!body.fileBytes?.trim() && !body.selfiImageFileBytes?.trim()) return null;

  let score = 0;
  if (/UploadApplicantDocument/i.test(fragment)) score += 20;
  if (/Uploading passport/i.test(fragment)) score += 5;
  if (body.fileBytes?.trim()) score += 10;
  if (fragment.includes("fileBytes")) score += 2;

  let from = "log fragment";
  if (/UploadApplicantDocument/i.test(fragment)) from = "UploadApplicantDocument Request";
  else if (/Request body:/i.test(fragment)) from = "Request body";

  return { json, score, from };
}

function collectJsonHits(raw: string): JsonHit[] {
  const hits: JsonHit[] = [];
  const seenJson = new Set<string>();

  const fragments = new Set<string>();
  for (const line of logicalLogLines(raw)) fragments.add(line);
  fragments.add(raw.replace(/\r\n/g, " "));

  for (const fragment of fragments) {
    if (!fragment.includes("fileBytes") && !/UploadApplicantDocument/i.test(fragment)) continue;
    const json = extractJsonFromFragment(fragment);
    if (!json || seenJson.has(json)) continue;
    seenJson.add(json);
    const hit = scoreFragment(fragment, json);
    if (hit) hits.push(hit);
  }

  if (hits.length === 0) {
    const json = extractJsonFromFragment(raw);
    if (json) {
      const hit = scoreFragment(raw, json);
      if (hit) hits.push(hit);
    }
  }

  return hits;
}

function mimeFromBase64(b64: string): string {
  const head = b64.trim().slice(0, 12);
  if (head.startsWith("iVBOR")) return "image/png";
  if (head.startsWith("UklGR")) return "image/webp";
  if (head.startsWith("/9j/") || head.startsWith("/9j")) return "image/jpeg";
  if (head.startsWith("R0lGOD")) return "image/gif";
  return "image/jpeg";
}

function toDataUrl(b64: string): string | null {
  if (!b64?.trim()) return null;
  let payload = b64.trim();
  if (payload.includes("base64,")) payload = payload.split("base64,").pop() ?? payload;
  const mime = mimeFromBase64(payload);
  return `data:${mime};base64,${payload}`;
}

export function byteLengthFromBase64(b64: string): number {
  let payload = b64.trim();
  if (payload.includes("base64,")) payload = payload.split("base64,").pop() ?? payload;
  const pad = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - pad;
}

export function parseVfsPassportFromLog(raw: string): ParsedVfsPassportFromLog {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty input");

  const hits = collectJsonHits(trimmed);
  if (hits.length === 0) {
    throw new Error(
      "No passport upload JSON found. Paste vfs-global-bot logs containing UploadApplicantDocument with fileBytes.",
    );
  }

  hits.sort((a, b) => a.score - b.score);
  const best = hits[hits.length - 1];
  const body = JSON.parse(best.json) as VfsUploadRequestBody;

  let imageField: "fileBytes" | "selfiImageFileBytes" | null = null;
  let b64: string | undefined;
  if (body.fileBytes?.trim()) {
    imageField = "fileBytes";
    b64 = body.fileBytes;
  } else if (body.selfiImageFileBytes?.trim()) {
    imageField = "selfiImageFileBytes";
    b64 = body.selfiImageFileBytes;
  }

  const imageDataUrl = b64 ? toDataUrl(b64) : null;
  if (!imageField || !imageDataUrl || !b64) {
    throw new Error("No fileBytes or selfiImageFileBytes in JSON");
  }

  return {
    body,
    passportNumberFromTail: extractPassportNumberFromLogTail(trimmed),
    imageField,
    imageDataUrl,
    decodedSizeBytes: byteLengthFromBase64(b64),
    matchedFrom: best.from,
  };
}
