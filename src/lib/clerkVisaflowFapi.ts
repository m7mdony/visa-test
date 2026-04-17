/** Shared Clerk Frontend API (FAPI) helpers for visaflow.devflexi.com. */

export const DEFAULT_CLERK_BASE = "https://clerk.visaflow.devflexi.com";
export const DEFAULT_APP_ORIGIN = "https://visaflow.devflexi.com";
export const DEFAULT_CLERK_API_VERSION = "2025-11-10";
export const DEFAULT_CLERK_JS_VERSION = "5.125.7";

export const CLERK_FAPI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

export function stripCookieHeaderPrefix(raw: string): string {
  let s = raw.trim();
  const m = s.match(/^cookie\s*:\s*/i);
  if (m) s = s.slice(m[0].length).trim();
  return s;
}

export function clerkFapiQuery(apiVersion: string, jsVersion: string): string {
  return new URLSearchParams({
    __clerk_api_version: apiVersion,
    _clerk_js_version: jsVersion,
  }).toString();
}

/** Merge `Set-Cookie` first segments into an existing `Cookie` header map (name → value). */
export function mergeCookieJar(existing: string, setCookieLines: string[]): string {
  const map = new Map<string, string>();

  const ingestHeader = (header: string) => {
    for (const part of header.split(";")) {
      const p = part.trim();
      const eq = p.indexOf("=");
      if (eq <= 0) continue;
      const name = p.slice(0, eq).trim();
      const value = p.slice(eq + 1).trim();
      const ln = name.toLowerCase();
      if (
        ln === "expires" ||
        ln === "max-age" ||
        ln === "path" ||
        ln === "domain" ||
        ln === "secure" ||
        ln === "httponly" ||
        ln === "samesite" ||
        ln === "partitioned"
      ) {
        continue;
      }
      map.set(name, value);
    }
  };

  ingestHeader(existing);
  for (const line of setCookieLines) {
    const first = line.split(";")[0]?.trim();
    if (!first?.includes("=")) continue;
    const eq = first.indexOf("=");
    map.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export function getSetCookieLines(res: Response): string[] {
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const one = res.headers.get("set-cookie");
  return one ? [one] : [];
}

export function clerkJsonErrorSummary(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const o = json as Record<string, unknown>;
  if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
  const errors = o.errors;
  if (Array.isArray(errors)) {
    const parts = errors.map((e) => {
      if (!e || typeof e !== "object") return "";
      const er = e as Record<string, unknown>;
      return String(er.long_message ?? er.message ?? "").trim();
    }).filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  try {
    return JSON.stringify(json).slice(0, 400);
  } catch {
    return "";
  }
}

/** Clerk FAPI: root + nested `response` messages, `errors[]`, `meta`. */
export function clerkFapiDeepSummary(json: unknown): string {
  const parts: string[] = [];

  const pushErrors = (node: Record<string, unknown>) => {
    const errors = node.errors;
    if (!Array.isArray(errors)) return;
    for (const e of errors) {
      if (!e || typeof e !== "object") continue;
      const er = e as Record<string, unknown>;
      const code = typeof er.code === "string" ? er.code : "";
      const msg = String(er.long_message ?? er.message ?? "").trim();
      if (msg) parts.push(code ? `[${code}] ${msg}` : msg);
    }
  };

  const walk = (node: unknown, depth: number) => {
    if (depth > 5 || !node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (typeof o.message === "string" && o.message.trim()) parts.push(o.message.trim());
    const meta = o.meta;
    if (meta && typeof meta === "object") {
      const m = meta as Record<string, unknown>;
      for (const k of ["client_message", "param_name", "trace_id"]) {
        const v = m[k];
        if (typeof v === "string" && v.trim()) parts.push(`${String(k)}: ${v.trim()}`);
      }
    }
    pushErrors(o);
    const resp = o.response;
    if (resp && typeof resp === "object") {
      const r = resp as Record<string, unknown>;
      if (typeof r.message === "string" && r.message.trim()) parts.push(`response: ${r.message.trim()}`);
      pushErrors(r);
      const st = r.status;
      if (typeof st === "string" && st.trim()) parts.push(`sign_in status: ${st}`);
    }
  };

  walk(json, 0);
  const dedup = [...new Set(parts.filter(Boolean))];
  if (dedup.length) return dedup.join(" | ");
  return clerkJsonErrorSummary(json);
}

export function clerkResponseSnippet(json: unknown, maxLen = 900): string {
  try {
    return JSON.stringify(json, null, 0).slice(0, maxLen);
  } catch {
    return "";
  }
}
