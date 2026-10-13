"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import VisaflowDashboardLoginPanel from "@/components/VisaflowDashboardLoginPanel";
import type { ProcessingClientRow } from "@/lib/processingClientsLastWeek";
import { buildDashboardClientCheckboxScript } from "@/lib/visaflowDashboardClientCheckboxScript";
import {
  applyRefreshedBearerJwt,
  buildDashboardAuthBody,
  ensureFreshBearerJwt,
  getOrganizationId,
  setOrganizationId,
  useVisaflowDashboardAuth,
} from "@/lib/visaflowDashboardAuth";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SS_ORG_ID = "ui-test-visaflow-org-id";
const SS_ROUTE_FROM = "ui-test-processing-week-route-from";
const SS_ROUTE_TO = "ui-test-processing-week-route-to";
const SS_LIMIT = "ui-test-processing-week-limit";

type RouteFilterOptions = {
  fromCountries: string[];
  toCountries: string[];
  subVisaCategories: string[];
};

function toDatetimeLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

function fmtTime(isoOrApi: string): string {
  if (!isoOrApi) return "—";
  let s = isoOrApi.trim();
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) s = s.replace(" ", "T").replace(/\+00$/, "+00:00");
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return isoOrApi;
  return d.toLocaleString();
}

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900";

const selectClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900";

type ApiTotals = {
  clientsScanned: number;
  statusMatchedClients: number;
  matchedAfterDateFilter: number;
  matchedClients: number;
  returnedClients: number;
  limit: number | null;
  clientStatus: string;
  fromCountry: string | null;
  toCountry: string | null;
  createdAfter: string;
  createdBefore: string;
};

type ApiResponse = {
  totals: ApiTotals;
  rows: ProcessingClientRow[];
  refreshedBearerJwt?: string;
  error?: string;
};

export default function ProcessingClientsLastWeekClient() {
  const now = Date.now();
  const [createdAfterStr, setCreatedAfterStr] = useState(() => toDatetimeLocal(new Date(now - WEEK_MS)));
  const [createdBeforeStr, setCreatedBeforeStr] = useState(() => toDatetimeLocal(new Date(now)));
  const [fromCountry, setFromCountry] = useState("");
  const [toCountry, setToCountry] = useState("");
  const [clientLimit, setClientLimit] = useState("50");
  const [routeFilterOptions, setRouteFilterOptions] = useState<RouteFilterOptions | null>(null);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [routesError, setRoutesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [copyScriptState, setCopyScriptState] = useState<"idle" | "copied" | "failed">("idle");
  const { authenticated: dashboardJwtSaved } = useVisaflowDashboardAuth();
  const [organizationId, setOrganizationIdState] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      return getOrganizationId() || sessionStorage.getItem(SS_ORG_ID)?.trim() || "";
    } catch {
      return getOrganizationId();
    }
  });

  useEffect(() => {
    try {
      const f = sessionStorage.getItem(SS_ROUTE_FROM);
      const t = sessionStorage.getItem(SS_ROUTE_TO);
      const lim = sessionStorage.getItem(SS_LIMIT);
      if (f) setFromCountry(f);
      if (t) setToCountry(t);
      if (lim) setClientLimit(lim);
    } catch {
      /* */
    }
  }, []);

  const fetchRouteOptions = useCallback(async () => {
    await ensureFreshBearerJwt();
    const { bearerJwt: bearerFromStorage, clerkSessionId: refreshSid, clerkCookie: refreshJar } =
      buildDashboardAuthBody();
    if (
      (!bearerFromStorage || bearerFromStorage.split(".").length < 2) &&
      !(refreshSid?.startsWith("sess_") && refreshJar)
    ) {
      setRouteFilterOptions(null);
      setRoutesError(null);
      return;
    }
    setRoutesLoading(true);
    setRoutesError(null);
    try {
      const res = await fetch("/api/dashboard-passport-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          passportNumbers: [],
          emails: [],
          bearerJwt: bearerFromStorage,
          ...(refreshSid?.startsWith("sess_") ? { clerkSessionId: refreshSid } : {}),
          ...(refreshJar ? { clerkCookie: refreshJar } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        filterOptions?: RouteFilterOptions;
        refreshedBearerJwt?: string;
      };
      if (!res.ok) {
        setRoutesError(json.error ?? `HTTP ${res.status}`);
        setRouteFilterOptions(null);
        return;
      }
      applyRefreshedBearerJwt(json.refreshedBearerJwt);
      setRouteFilterOptions(json.filterOptions ?? null);
    } catch (e: unknown) {
      setRoutesError(e instanceof Error ? e.message : "Route lookup failed");
      setRouteFilterOptions(null);
    } finally {
      setRoutesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!dashboardJwtSaved) {
      setRouteFilterOptions(null);
      setRoutesError(null);
      return;
    }
    void fetchRouteOptions();
  }, [dashboardJwtSaved, fetchRouteOptions]);

  const summary = useMemo(() => data?.totals ?? null, [data]);

  const dashboardConsoleScript = useMemo(() => {
    if (!data?.rows.length) return "";
    return buildDashboardClientCheckboxScript(data.rows);
  }, [data?.rows]);

  async function copyDashboardScript() {
    if (!dashboardConsoleScript) return;
    try {
      await navigator.clipboard.writeText(dashboardConsoleScript);
      setCopyScriptState("copied");
      window.setTimeout(() => setCopyScriptState("idle"), 2000);
    } catch {
      setCopyScriptState("failed");
      window.setTimeout(() => setCopyScriptState("idle"), 2500);
    }
  }

  function applyLastWeekPreset() {
    const to = new Date();
    const from = new Date(to.getTime() - WEEK_MS);
    setCreatedAfterStr(toDatetimeLocal(from));
    setCreatedBeforeStr(toDatetimeLocal(to));
  }

  async function handleLoad() {
    setError(null);
    setData(null);
    const afterMs = new Date(createdAfterStr).getTime();
    const beforeMs = new Date(createdBeforeStr).getTime();
    if (!Number.isFinite(afterMs) || !Number.isFinite(beforeMs) || afterMs >= beforeMs) {
      setError("Created from must be before created to.");
      return;
    }

    const limitNum = parseInt(clientLimit.trim(), 10);
    if (!Number.isFinite(limitNum) || limitNum <= 0) {
      setError("Enter how many clients you need (a positive number).");
      return;
    }

    if (organizationId.trim()) setOrganizationId(organizationId.trim());
    await ensureFreshBearerJwt();
    const {
      bearerJwt: bearerFromStorage,
      clerkSessionId: refreshSid,
      clerkCookie: refreshJar,
      organizationId: orgFromStorage,
    } = buildDashboardAuthBody();

    if (
      (!bearerFromStorage || bearerFromStorage.split(".").length < 2) &&
      !(refreshSid?.startsWith("sess_") && refreshJar)
    ) {
      setError("Sign in with Visaflow dashboard OTP first (same as Stuck page).");
      return;
    }

    try {
      sessionStorage.setItem(SS_ROUTE_FROM, fromCountry);
      sessionStorage.setItem(SS_ROUTE_TO, toCountry);
      sessionStorage.setItem(SS_LIMIT, String(limitNum));
    } catch {
      /* */
    }

    setLoading(true);
    try {
      const res = await fetch("/api/processing-clients-last-week", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bearerJwt: bearerFromStorage,
          ...(refreshSid?.startsWith("sess_") ? { clerkSessionId: refreshSid } : {}),
          ...(refreshJar ? { clerkCookie: refreshJar } : {}),
          organizationId: organizationId.trim() || orgFromStorage,
          createdAfter: new Date(afterMs).toISOString(),
          createdBefore: new Date(beforeMs).toISOString(),
          clientStatus: "processing",
          limit: limitNum,
          ...(fromCountry ? { fromCountry } : {}),
          ...(toCountry ? { toCountry } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as ApiResponse;
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      applyRefreshedBearerJwt(json.refreshedBearerJwt);
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900">Processing clients (created window)</h1>
        <p className="mt-1 text-sm text-zinc-600">
          <code className="text-xs bg-zinc-100 px-1 rounded">GET /clients</code> ·{" "}
          <code className="text-xs bg-zinc-100 px-1 rounded">status=processing</code> · filter by created range, optional
          route, then return up to N rows (newest first).
        </p>
      </div>

      <VisaflowDashboardLoginPanel hint="Same OTP login as Stuck — JWT is shared across ui-test pages." />

      <fieldset className="space-y-4 rounded-lg border border-zinc-200 p-4">
        <legend className="px-1 text-sm font-medium text-zinc-800">Created between</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-zinc-700">From</span>
            <input
              type="datetime-local"
              className={`${inputClass} mt-1`}
              value={createdAfterStr}
              onChange={(e) => setCreatedAfterStr(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-700">To</span>
            <input
              type="datetime-local"
              className={`${inputClass} mt-1`}
              value={createdBeforeStr}
              onChange={(e) => setCreatedBeforeStr(e.target.value)}
            />
          </label>
        </div>
        <button
          type="button"
          onClick={applyLastWeekPreset}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50"
        >
          Preset: last 7 days
        </button>
      </fieldset>

      <fieldset className="space-y-4 rounded-lg border border-zinc-200 p-4">
        <legend className="px-1 text-sm font-medium text-zinc-800">Route (optional)</legend>
        {routesLoading ? <p className="text-xs text-zinc-500">Loading country lists from /clients…</p> : null}
        {routesError ? <p className="text-xs text-amber-800">{routesError}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-zinc-700">From country</span>
            <select
              className={`${selectClass} mt-1 font-mono text-xs`}
              value={fromCountry}
              onChange={(e) => setFromCountry(e.target.value)}
              disabled={!routeFilterOptions}
            >
              <option value="">Any</option>
              {(routeFilterOptions?.fromCountries ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-zinc-700">To country</span>
            <select
              className={`${selectClass} mt-1 font-mono text-xs`}
              value={toCountry}
              onChange={(e) => setToCountry(e.target.value)}
              disabled={!routeFilterOptions}
            >
              <option value="">Any</option>
              {(routeFilterOptions?.toCountries ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium text-zinc-800">How many clients</span>
          <input
            type="number"
            min={1}
            max={2000}
            className={`${inputClass} mt-1`}
            value={clientLimit}
            onChange={(e) => setClientLimit(e.target.value)}
          />
          <span className="mt-1 block text-xs text-zinc-500">Newest matching rows first (max 2000).</span>
        </label>
        <label className="block text-sm">
          <span className="font-medium text-zinc-800">Organization id (optional)</span>
          <input
            className={`${inputClass} mt-1 font-mono text-xs`}
            value={organizationId}
            onChange={(e) => setOrganizationIdState(e.target.value)}
            placeholder="Clerk org id if /clients is empty"
          />
        </label>
      </div>

      <button
        type="button"
        disabled={loading || !dashboardJwtSaved}
        onClick={() => void handleLoad()}
        className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {loading ? "Loading /clients…" : "Load processing clients"}
      </button>

      {error ? (
        <p className="text-sm text-red-700 whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 px-3 py-2">
          {error}
        </p>
      ) : null}

      {summary ? (
        <p className="text-sm text-zinc-700">
          <strong>{summary.returnedClients}</strong> shown
          {summary.limit != null && summary.matchedClients > summary.returnedClients
            ? ` (of ${summary.matchedClients} matching)`
            : null}
          {" · "}
          {summary.matchedClients} match filters · {summary.statusMatchedClients} processing · {summary.clientsScanned}{" "}
          scanned
          {summary.fromCountry || summary.toCountry ? (
            <>
              {" "}
              · route{" "}
              <code className="text-xs">
                {summary.fromCountry ?? "*"} → {summary.toCountry ?? "*"}
              </code>
            </>
          ) : null}
          <br />
          <span className="text-zinc-600">
            Created {fmtTime(summary.createdAfter)} → {fmtTime(summary.createdBefore)}
          </span>
        </p>
      ) : null}

      {dashboardConsoleScript ? (
        <div className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-zinc-900">Visaflow dashboard console script</h2>
              <p className="text-xs text-zinc-600 mt-0.5">
                Open Visaflow clients (matching filters), Console → paste → Enter. Auto-scrolls to load lazy rows. Checks
                only your search list ({data?.rows.length ?? 0} clients), not every row on the dashboard.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void copyDashboardScript()}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-100"
            >
              {copyScriptState === "copied"
                ? "Copied"
                : copyScriptState === "failed"
                  ? "Copy failed — select text below"
                  : "Copy script"}
            </button>
          </div>
          <textarea
            readOnly
            className="w-full min-h-[220px] rounded-lg border border-zinc-300 bg-white p-3 font-mono text-[11px] leading-relaxed text-zinc-800"
            value={dashboardConsoleScript}
            spellCheck={false}
            onFocus={(e) => e.target.select()}
          />
        </div>
      ) : null}

      {data && data.rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-zinc-200">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-zinc-50 text-zinc-600">
              <tr>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Route</th>
                <th className="px-3 py-2 font-medium">Center / category</th>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Passport(s)</th>
                <th className="px-3 py-2 font-medium">Applicants</th>
                <th className="px-3 py-2 font-medium">Client id</th>
                <th className="px-3 py-2 font-medium">Notes / error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {data.rows.map((row) => (
                <tr key={row.clientId} className="align-top hover:bg-zinc-50/80">
                  <td className="px-3 py-2 whitespace-nowrap">{fmtTime(row.createdAt)}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {row.fromCountry || "—"} → {row.toCountry || "—"}
                  </td>
                  <td className="px-3 py-2 max-w-xs">
                    <div className="text-xs text-zinc-800">{row.visaCenterName || "—"}</div>
                    <div className="text-xs text-zinc-500 truncate" title={row.subVisaCategoryName}>
                      {row.subVisaCategoryName || row.visaCategoryName || "—"}
                    </div>
                  </td>
                  <td className="px-3 py-2">{row.userName || "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {row.applicants.length === 0 ? (
                      "—"
                    ) : (
                      <ul className="space-y-1">
                        {row.applicants.map((ap) => (
                          <li key={ap.applicantId}>
                            {ap.passportNumber || "—"}
                            <span className="block font-sans text-[11px] text-zinc-500">
                              {ap.displayName || [ap.firstName, ap.lastName].filter(Boolean).join(" ") || "—"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">{row.applicantCount}</td>
                  <td className="px-3 py-2 font-mono text-[11px] max-w-[140px] break-all">{row.clientId}</td>
                  <td className="px-3 py-2 text-xs text-zinc-600 max-w-[200px]">
                    {row.notes}
                    {row.errorMessage ? (
                      <span className="block text-red-700 mt-1">{row.errorMessage}</span>
                    ) : null}
                    {row.isPaused ? <span className="block text-amber-700 mt-1">Paused</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {data && data.rows.length === 0 && !error ? (
        <p className="text-sm text-zinc-600">No processing clients match these filters.</p>
      ) : null}
    </div>
  );
}
