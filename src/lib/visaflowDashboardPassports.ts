/** Normalize passport strings for matching dashboard `passportNumber` values. */
export function normalizePassportKey(s: string): string {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

export type DashboardApplicantRef = { id: string; passportNumber: string };

/** Deep-walk JSON (e.g. `GET /clients`) and collect `{ id, passportNumber }` from any `applicants` arrays. */
export function collectApplicantsFromPayload(json: unknown): DashboardApplicantRef[] {
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
        if (typeof id !== "string" || !id) continue;
        const pn = ap.passportNumber;
        out.push({ id, passportNumber: pn != null && pn !== "" ? String(pn) : "" });
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

export function findApplicantIdByPassport(
  applicants: DashboardApplicantRef[],
  passportQuery: string,
): string | null {
  const want = normalizePassportKey(passportQuery);
  if (!want) return null;
  for (const a of applicants) {
    if (normalizePassportKey(a.passportNumber) === want) return a.id;
  }
  return null;
}

export type PassportImageEntry = { id: string; url: string };

export type ApplicantImagesPayload = {
  success?: boolean;
  applicant?: { firstName?: string; lastName?: string; status?: string };
  images?: {
    passportImages?: PassportImageEntry[];
    videos?: string[];
  };
  hasImages?: boolean;
  error?: string;
};
