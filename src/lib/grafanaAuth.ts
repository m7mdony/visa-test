/**
 * Grafana HTTP API auth for server-side Loki queries.
 *
 * If Grafana login UI is Google (or other OAuth), POST /login with user/password often
 * no longer returns a session cookie. Prefer a long-lived token:
 *
 * - `GRAFANA_API`, `GRAFANA_TOKEN`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, or `GRAFANA_API_TOKEN`: `Authorization: Bearer …`
 *   (with a token, Loki is queried via `/api/datasources/proxy/uid/…/loki/api/v1/query_range`.)
 * - Fallback: `GRAFANA_USER` + `GRAFANA_PASSWORD` → session cookie from POST `/login`
 */

import { getCookieHeader } from "@/lib/grafanaLoki";

const USER_AGENT_LOKI = "Mozilla/5.0 (compatible; UiTest-Loki/1.0)";

const GRAFANA_USER = process.env.GRAFANA_USER ?? "admin";
const GRAFANA_PASSWORD = process.env.GRAFANA_PASSWORD ?? "";

export function getGrafanaBearerToken(): string | null {
  const raw =
    process.env.GRAFANA_API?.trim() ||
    process.env.GRAFANA_TOKEN?.trim() ||
    process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN?.trim() ||
    process.env.GRAFANA_API_TOKEN?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/** Legacy session cookie from Grafana basic login API (when enabled). */
export async function fetchGrafanaCookieSession(base: string): Promise<string> {
  const loginUrl = `${base}/login`;
  const loginRes = await fetch(loginUrl, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT_LOKI,
      Accept: "application/json",
      "Content-Type": "application/json",
      Referer: loginUrl,
    },
    body: JSON.stringify({
      user: GRAFANA_USER,
      password: GRAFANA_PASSWORD,
    }),
    redirect: "manual",
    // @ts-expect-error Node fetch may accept this for self-signed
    rejectUnauthorized: false,
  });
  let setCookie: string[] = [];
  if (typeof loginRes.headers.getSetCookie === "function") {
    setCookie = loginRes.headers.getSetCookie();
  } else {
    const sc = loginRes.headers.get("set-cookie");
    if (sc) setCookie = [sc];
  }
  return getCookieHeader(setCookie);
}

export type GrafanaDsQueryAuth =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; error: string };

/**
 * Headers for Grafana `/api/ds/query` JSON calls.
 */
export async function resolveGrafanaDsQueryHeaders(base: string): Promise<GrafanaDsQueryAuth> {
  const token = getGrafanaBearerToken();
  const common: Record<string, string> = {
    "User-Agent": USER_AGENT_LOKI,
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: base,
  };
  if (token) {
    return { ok: true, headers: { ...common, Authorization: `Bearer ${token}` } };
  }
  const cookieHeader = await fetchGrafanaCookieSession(base);
  if (!cookieHeader) {
    return {
      ok: false,
      error:
        "Grafana login failed (no session cookie). Set GRAFANA_API (or GRAFANA_SERVICE_ACCOUNT_TOKEN / GRAFANA_API_TOKEN), or keep GRAFANA_USER + GRAFANA_PASSWORD if /login accepts basic auth.",
    };
  }
  return { ok: true, headers: { ...common, Cookie: cookieHeader } };
}
