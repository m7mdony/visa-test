/** Normalize passport strings for matching dashboard `passportNumber` values. */
export function normalizePassportKey(s: string): string {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

export type DashboardApplicantRef = { id: string; passportNumber: string };

function applicantPassportField(ap: Record<string, unknown>): string {
  for (const k of ["passportNumber", "passport", "PassportNumber", "passportNo"]) {
    const v = ap[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

/** Dashboard `GET /applicants/images/{id}` expects a single UUID — not Redis `payload.id` (client correlation id). */
export function isDashboardApplicantId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());
}

/** Parse `GET /clients` → `{ success, data: [{ applicants: [{ id, passportNumber }] }] }`. */
export function collectApplicantsFromPayload(json: unknown): DashboardApplicantRef[] {
  const root = json as Record<string, unknown>;
  const data = root?.data;
  if (Array.isArray(data)) {
    const out: DashboardApplicantRef[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const applicants = (item as Record<string, unknown>).applicants;
      if (!Array.isArray(applicants)) continue;
      for (const a of applicants) {
        if (!a || typeof a !== "object") continue;
        const ap = a as Record<string, unknown>;
        const id = ap.id;
        if (typeof id !== "string" || !id.trim()) continue;
        out.push({ id: id.trim(), passportNumber: applicantPassportField(ap) });
      }
    }
    if (out.length > 0) return out;
  }

  const out: DashboardApplicantRef[] = [];

  const visit = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x);
      return;
    }
    if (typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const applicants = o.applicants;
    if (Array.isArray(applicants)) {
      for (const a of applicants) {
        if (!a || typeof a !== "object") continue;
        const ap = a as Record<string, unknown>;
        const id = ap.id;
        if (typeof id !== "string" || !id.trim()) continue;
        out.push({ id: id.trim(), passportNumber: applicantPassportField(ap) });
      }
    }
    for (const k of Object.keys(o)) {
      if (k === "applicants") continue;
      visit(o[k]);
    }
  };

  visit(json);
  return out;
}

function loosePassportKey(s: string): string {
  return normalizePassportKey(s).replace(/[^a-z0-9]/g, "");
}

export function findApplicantIdByPassport(
  applicants: DashboardApplicantRef[],
  passportQuery: string,
): string | null {
  const want = normalizePassportKey(passportQuery);
  const wantLoose = loosePassportKey(passportQuery);
  if (!want) return null;
  for (const a of applicants) {
    const key = normalizePassportKey(a.passportNumber);
    if (!key) continue;
    if (key === want) return a.id;
    if (wantLoose && loosePassportKey(a.passportNumber) === wantLoose) return a.id;
    if (key.endsWith(want) || want.endsWith(key)) return a.id;
  }
  return null;
}

/** Normalized passport → applicant id from `GET /clients`. */
export function indexApplicantIdsByPassport(
  applicants: DashboardApplicantRef[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of applicants) {
    const key = normalizePassportKey(a.passportNumber);
    if (!key || m.has(key)) continue;
    m.set(key, a.id);
  }
  return m;
}

/** Store + lookup dashboard media by normalized passport key. */
export function indexByNormalizedPassport<T extends { passportNumber?: string | null }>(
  items: Array<{ passport: string; value: T }>,
): Record<string, T & { passportNumber: string }> {
  const out: Record<string, T & { passportNumber: string }> = {};
  for (const { passport, value } of items) {
    const key = normalizePassportKey(passport);
    if (!key) continue;
    out[key] = { ...value, passportNumber: passport.trim() };
  }
  return out;
}

export function lookupByPassportKey<T>(map: Record<string, T>, passport: string): T | undefined {
  const key = normalizePassportKey(passport);
  if (!key) return undefined;
  return map[key] ?? map[passport.trim()];
}

export type PassportImageEntry = { id: string; url: string };

export type GestureClipEntry = { gesture: string; clipUrl: string };

export type ApplicantImagesPayload = {
  success?: boolean;
  applicant?: { firstName?: string; lastName?: string; status?: string };
  images?: {
    passportImages?: PassportImageEntry[];
    videos?: string[];
    gestureClips?: Array<{ gesture?: string; clipUrl?: string }>;
  };
  gestureClips?: Array<{ gesture?: string; clipUrl?: string }>;
  hasImages?: boolean;
  error?: string;
};

export function parseVideosFromApplicantImages(data: ApplicantImagesPayload): string[] {
  const raw = data.images?.videos;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
}

export function parseGestureClipsFromApplicantImages(data: ApplicantImagesPayload): GestureClipEntry[] {
  const raw = data.images?.gestureClips ?? data.gestureClips;
  if (!Array.isArray(raw)) return [];
  const out: GestureClipEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const gesture = typeof item.gesture === "string" ? item.gesture.trim() : "";
    const clipUrl = typeof item.clipUrl === "string" ? item.clipUrl.trim() : "";
    if (!gesture || !clipUrl) continue;
    out.push({ gesture, clipUrl });
  }
  return out;
}

export function findGestureClipUrl(
  clips: GestureClipEntry[] | undefined,
  gesture: string,
): string | null {
  if (!clips?.length || !gesture.trim()) return null;
  const want = gesture.trim();
  const exact = clips.find((c) => c.gesture === want);
  if (exact?.clipUrl) return exact.clipUrl;
  const ci = clips.find((c) => c.gesture.toLowerCase() === want.toLowerCase());
  return ci?.clipUrl ?? null;
}
