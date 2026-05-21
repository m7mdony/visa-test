import { normalizePassportKey } from "@/lib/visaflowDashboardPassports";

export type PassportRouteInfo = {
  passportNumber: string;
  normalizedKey: string;
  fromCountry: string;
  toCountry: string;
  subVisaCategoryName: string;
  clientId: string;
  applicantId: string;
};

function strField(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function subVisaFromClient(c: Record<string, unknown>): string {
  const direct = strField(c.subVisaCategoryName);
  if (direct) return direct;
  const nested = c.subVisaCategory;
  if (nested && typeof nested === "object") {
    return strField((nested as Record<string, unknown>).name);
  }
  return "";
}

/** Walk `GET /clients` payload and map each applicant passport to its client route. */
export function collectPassportRoutesFromClientsPayload(json: unknown): PassportRouteInfo[] {
  const root = json as Record<string, unknown>;
  const arr = Array.isArray(root?.data) ? (root.data as unknown[]) : [];
  const out: PassportRouteInfo[] = [];

  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const clientId = strField(c.id);
    if (!clientId) continue;
    const fromCountry = strField(c.fromCountry).toLowerCase();
    const toCountry = strField(c.toCountry).toLowerCase();
    const subVisaCategoryName = subVisaFromClient(c);
    const applicants = Array.isArray(c.applicants) ? c.applicants : [];
    for (const apRaw of applicants) {
      if (!apRaw || typeof apRaw !== "object") continue;
      const ap = apRaw as Record<string, unknown>;
      const applicantId = strField(ap.id);
      const passportNumber = strField(ap.passportNumber);
      if (!applicantId || !passportNumber) continue;
      out.push({
        passportNumber,
        normalizedKey: normalizePassportKey(passportNumber),
        fromCountry,
        toCountry,
        subVisaCategoryName,
        clientId,
        applicantId,
      });
    }
  }
  return out;
}

export function indexPassportRoutes(routes: PassportRouteInfo[]): Map<string, PassportRouteInfo> {
  const m = new Map<string, PassportRouteInfo>();
  for (const r of routes) {
    if (!r.normalizedKey) continue;
    if (!m.has(r.normalizedKey)) m.set(r.normalizedKey, r);
  }
  return m;
}

function applicantEmail(ap: Record<string, unknown>): string {
  for (const k of ["email", "vfsEmail", "loginEmail", "loginUser", "userEmail"]) {
    const v = strField(ap[k]);
    if (v.includes("@")) return v.toLowerCase();
  }
  return "";
}

/** Map dashboard applicant email → client route (same passport route as on client). */
export function buildEmailToRouteFromClientsPayload(json: unknown): Map<string, PassportRouteInfo> {
  const root = json as Record<string, unknown>;
  const arr = Array.isArray(root?.data) ? (root.data as unknown[]) : [];
  const m = new Map<string, PassportRouteInfo>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const clientId = strField(c.id);
    if (!clientId) continue;
    const fromCountry = strField(c.fromCountry).toLowerCase();
    const toCountry = strField(c.toCountry).toLowerCase();
    const subVisaCategoryName = subVisaFromClient(c);
    const applicants = Array.isArray(c.applicants) ? c.applicants : [];
    for (const apRaw of applicants) {
      if (!apRaw || typeof apRaw !== "object") continue;
      const ap = apRaw as Record<string, unknown>;
      const email = applicantEmail(ap);
      const passportNumber = strField(ap.passportNumber);
      if (!email || !passportNumber) continue;
      const route: PassportRouteInfo = {
        passportNumber,
        normalizedKey: normalizePassportKey(passportNumber),
        fromCountry,
        toCountry,
        subVisaCategoryName,
        clientId,
        applicantId: strField(ap.id),
      };
      if (!m.has(email)) m.set(email, route);
    }
  }
  return m;
}

export function routeMatchesFilter(route: PassportRouteInfo, filter: RouteFilterSelection): boolean {
  if (filter.fromCountry && route.fromCountry !== filter.fromCountry) return false;
  if (filter.toCountry && route.toCountry !== filter.toCountry) return false;
  if (filter.subVisaCategoryName && route.subVisaCategoryName !== filter.subVisaCategoryName) return false;
  return true;
}

export function resolveRouteForEvent(
  email: string | null | undefined,
  passportNumber: string | null | undefined,
  routesByKey: Map<string, PassportRouteInfo>,
  emailToRoute: Map<string, PassportRouteInfo>
): PassportRouteInfo | undefined {
  const key = passportNumber ? normalizePassportKey(passportNumber) : "";
  if (key) {
    const byPassport = routesByKey.get(key);
    if (byPassport) return byPassport;
  }
  const em = email?.trim().toLowerCase();
  if (em && em.includes("@")) return emailToRoute.get(em);
  return undefined;
}

export function buildRouteFilterOptions(routes: PassportRouteInfo[]): {
  fromCountries: string[];
  toCountries: string[];
  subVisaCategories: string[];
} {
  const from = new Set<string>();
  const to = new Set<string>();
  const sub = new Set<string>();
  for (const r of routes) {
    if (r.fromCountry) from.add(r.fromCountry);
    if (r.toCountry) to.add(r.toCountry);
    if (r.subVisaCategoryName) sub.add(r.subVisaCategoryName);
  }
  const sort = (a: string, b: string) => a.localeCompare(b);
  return {
    fromCountries: [...from].sort(sort),
    toCountries: [...to].sort(sort),
    subVisaCategories: [...sub].sort(sort),
  };
}

export type RouteFilterSelection = {
  fromCountry: string;
  toCountry: string;
  subVisaCategoryName: string;
};

export function isRouteFilterActive(filter: RouteFilterSelection): boolean {
  return Boolean(filter.fromCountry || filter.toCountry || filter.subVisaCategoryName);
}

export function eventMatchesRouteFilter(
  email: string | null | undefined,
  passportNumber: string | null | undefined,
  routesByKey: Map<string, PassportRouteInfo>,
  emailToRoute: Map<string, PassportRouteInfo>,
  filter: RouteFilterSelection
): boolean {
  if (!isRouteFilterActive(filter)) return true;
  const route = resolveRouteForEvent(email, passportNumber, routesByKey, emailToRoute);
  if (!route) return false;
  return routeMatchesFilter(route, filter);
}

/** Unique route triples present in the report (for combined filter dropdown). */
export function buildRouteCombinationOptions(routes: PassportRouteInfo[]): Array<{
  id: string;
  fromCountry: string;
  toCountry: string;
  subVisaCategoryName: string;
  label: string;
}> {
  const seen = new Set<string>();
  const out: Array<{
    id: string;
    fromCountry: string;
    toCountry: string;
    subVisaCategoryName: string;
    label: string;
  }> = [];
  for (const r of routes) {
    const id = `${r.fromCountry}|${r.toCountry}|${r.subVisaCategoryName}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const from = r.fromCountry ? r.fromCountry.toUpperCase() : "—";
    const to = r.toCountry ? r.toCountry.toUpperCase() : "—";
    const sub = r.subVisaCategoryName || "—";
    out.push({
      id,
      fromCountry: r.fromCountry,
      toCountry: r.toCountry,
      subVisaCategoryName: r.subVisaCategoryName,
      label: `${from} → ${to} · ${sub}`,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
