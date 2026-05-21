"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import DeniedPassportsByPassportSection from "@/components/DeniedPassportsByPassportSection";
import type { DeniedPassportRow } from "@/lib/deniedPassports";
import { computeDeniedRecoveryByEmail, type DeniedEmailRecovery } from "@/lib/deniedRecovery";
import { collectEmailsFromReportData, collectPassportsFromReportData } from "@/lib/reportEvents";
import { computeFilteredTopStats } from "@/lib/reportRouteFilter";
import {
  eventMatchesRouteFilter,
  indexPassportRoutes,
  isRouteFilterActive,
  type PassportRouteInfo,
  type RouteFilterSelection,
} from "@/lib/visaflowDashboardClients";

const SS_BEARER_JWT = "ui-test-visaflow-dashboard-bearer-jwt";
const SS_CLERK_REFRESH_SESSION_ID = "ui-test-visaflow-clerk-refresh-session-id";
const SS_OTP_COOKIE_JAR = "ui-test-clerk-otp-cookie-jar";

type SolveKindUi = "drop" | "verification";
type DeploymentEnvUi = "prod" | "staging";

type ApiResponse = {
  from: number;
  to: number;
  target: string;
  solveKind?: SolveKindUi;
  deploymentEnv?: DeploymentEnvUi;
  vfsLokiNamespace?: string | null;
  vfsCorrelationApp?: string;
  azureCorrelationApp?: string;
  totals: {
    approvedVideoCount?: number;
    deniedVideoCount?: number;
    approvedApplicantCount?: number;
    deniedApplicantCount?: number;
    erroredVideoAttemptCount?: number;
    idnfyStatusRawLogLines?: number;
    idnfyStatusResponseLogLines?: number;
    inHouseVerificationPassedAvgMs?: number | null;
    applicantCount: number;
    successCount: number;
    failureCount: number;
    terminalFailureLogCount?: number;
    pendingCount: number;
    solvedOnFirstTry: number;
    solvedOnSecondTry: number;
    solvedOnThirdTry: number;
    solvingLogLines: number;
    solvingLogLinesRaw?: number;
    successLogLines: number;
    failLogLines: number;
    identityVerificationLogLines?: number;
    identityOutcomeLogLines?: number;
    solverLogLines?: number;
    azureLivenessLogLines?: number;
    azureSessionPrefixesMapped?: number;
    solvingExcludedNoTaskId?: number;
    solvingExcludedNoAzureMatch?: number;
    solvingExcludedWrongKind?: number;
    azurePayloadLogLines?: number;
    azureResultFailedLogLines?: number;
    taskPayloadRows?: number;
    azureInvalidTokenJobCount?: number;
  };
  taskPayloadIatRows?: Array<{
    solvingTaskId: string;
    sessionPrefix: string;
    messageId: string | null;
    actualLogTime: string;
    iatTime: string | null;
    invalidToken: boolean;
  }>;
  applicantOutcomes?: Array<{
    email: string;
    outcome: "success" | "failed" | "pending";
    successOnTry: 1 | 2 | 3 | null;
    solverFailureCount?: number;
  }>;
  failureReasonBreakdown?: Array<{
    reason: string;
    count: number;
    samples?: Array<{
      email: string;
      passportNumber: string | null;
      videoLink: string | null;
    }>;
  }>;
  deniedPassportRows?: DeniedPassportRow[];
  deniedPassportErrors?: string[];
  deniedRecoveryByEmail?: Record<string, DeniedEmailRecovery>;
  reportEvents?: {
    statusVideos: Array<{
      status: "APPROVED" | "DENIED";
      email: string;
      passportNumber: string | null;
      at: string;
    }>;
    inHousePassed: Array<{ email: string; passportNumber: string | null; at: string }>;
    deniedApplicants: Array<{ email: string; passportNumber: string | null; at: string }>;
    erroredAttempts: Array<{
      email: string;
      passportNumber: string | null;
      reason: string;
      at: string;
    }>;
  };
};

type RouteFilterOptions = {
  fromCountries: string[];
  toCountries: string[];
  subVisaCategories: string[];
};

type RouteCombination = {
  id: string;
  fromCountry: string;
  toCountry: string;
  subVisaCategoryName: string;
  label: string;
};

const EMPTY_ROUTE_FILTER: RouteFilterSelection = {
  fromCountry: "",
  toCountry: "",
  subVisaCategoryName: "",
};

const INTERVAL_MS: Record<string, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

function toDatetimeLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

function fmtTimeMs(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const base = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
  return `${base}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export default function ApprovedVideosClient() {
  const now = Date.now();
  const defaultFrom = new Date(now - INTERVAL_MS["24h"]);
  const defaultTo = new Date(now);
  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(defaultFrom));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(defaultTo));
  const [target, setTarget] = useState("vfs-global-bot");
  const [deploymentEnv, setDeploymentEnv] = useState<DeploymentEnvUi>("prod");
  const [solveKind, setSolveKind] = useState<SolveKindUi>("drop");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [routeFilter, setRouteFilter] = useState<RouteFilterSelection>(EMPTY_ROUTE_FILTER);
  const [passportRoutes, setPassportRoutes] = useState<PassportRouteInfo[]>([]);
  const [emailToRoute, setEmailToRoute] = useState<Map<string, PassportRouteInfo>>(new Map());
  const [routeFilterOptions, setRouteFilterOptions] = useState<RouteFilterOptions | null>(null);
  const [routeCombinations, setRouteCombinations] = useState<RouteCombination[]>([]);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [routesError, setRoutesError] = useState<string | null>(null);
  const [dashboardJwtSaved, setDashboardJwtSaved] = useState(false);

  const refreshJwtFlag = useCallback(() => {
    try {
      setDashboardJwtSaved(Boolean(sessionStorage.getItem(SS_BEARER_JWT)?.trim()));
    } catch {
      setDashboardJwtSaved(false);
    }
  }, []);

  useEffect(() => {
    refreshJwtFlag();
    const onJwt = () => refreshJwtFlag();
    window.addEventListener("visaflow-jwt-updated", onJwt);
    window.addEventListener("focus", onJwt);
    return () => {
      window.removeEventListener("visaflow-jwt-updated", onJwt);
      window.removeEventListener("focus", onJwt);
    };
  }, [refreshJwtFlag]);

  const fetchPassportRoutes = useCallback(async (report: ApiResponse) => {
    let bearerFromStorage = "";
    let refreshSid = "";
    let refreshJar = "";
    try {
      bearerFromStorage = sessionStorage.getItem(SS_BEARER_JWT)?.trim() ?? "";
      refreshSid = sessionStorage.getItem(SS_CLERK_REFRESH_SESSION_ID)?.trim() ?? "";
      refreshJar = sessionStorage.getItem(SS_OTP_COOKIE_JAR)?.trim() ?? "";
    } catch {
      /* */
    }
    if (!bearerFromStorage || bearerFromStorage.split(".").length < 2) {
      setPassportRoutes([]);
      setRouteFilterOptions(null);
      setRoutesError(null);
      return;
    }
    const passportNumbers = collectPassportsFromReportData(report);
    const emails = collectEmailsFromReportData(report);
    setRoutesLoading(true);
    setRoutesError(null);
    try {
      const res = await fetch("/api/dashboard-passport-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          passportNumbers,
          emails,
          bearerJwt: bearerFromStorage,
          ...(refreshSid.startsWith("sess_") ? { clerkSessionId: refreshSid } : {}),
          ...(refreshJar ? { clerkCookie: refreshJar } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        routes?: PassportRouteInfo[];
        filterOptions?: RouteFilterOptions;
        routeCombinations?: RouteCombination[];
        emailToRoute?: Record<string, PassportRouteInfo>;
        refreshedBearerJwt?: string;
      };
      if (!res.ok) {
        setRoutesError(json.error ?? `HTTP ${res.status}`);
        setPassportRoutes([]);
        setEmailToRoute(new Map());
        setRouteFilterOptions(null);
        setRouteCombinations([]);
        return;
      }
      const nextJwt = typeof json.refreshedBearerJwt === "string" ? json.refreshedBearerJwt.trim() : "";
      if (nextJwt && nextJwt.split(".").length >= 2) {
        try {
          sessionStorage.setItem(SS_BEARER_JWT, nextJwt);
        } catch {
          /* */
        }
      }
      setPassportRoutes(json.routes ?? []);
      setRouteFilterOptions(json.filterOptions ?? null);
      setRouteCombinations(json.routeCombinations ?? []);
      const em = new Map<string, PassportRouteInfo>();
      for (const [k, v] of Object.entries(json.emailToRoute ?? {})) {
        if (v && typeof v === "object") em.set(k.toLowerCase(), v);
      }
      setEmailToRoute(em);
    } catch (e: unknown) {
      setRoutesError(e instanceof Error ? e.message : "Route lookup failed");
      setPassportRoutes([]);
      setEmailToRoute(new Map());
      setRouteFilterOptions(null);
      setRouteCombinations([]);
    } finally {
      setRoutesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!data || !dashboardJwtSaved) {
      if (!data) {
        setPassportRoutes([]);
        setEmailToRoute(new Map());
        setRouteFilterOptions(null);
        setRouteCombinations([]);
        setRoutesError(null);
      }
      return;
    }
    void fetchPassportRoutes(data);
  }, [data, dashboardJwtSaved, fetchPassportRoutes]);

  useEffect(() => {
    if (!data) setRouteFilter(EMPTY_ROUTE_FILTER);
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return null;
    const baseDenied = data.deniedPassportRows ?? [];
    if (!isRouteFilterActive(routeFilter) || !data.reportEvents) {
      return {
        approvedVideoCount: data.totals.approvedVideoCount ?? 0,
        deniedVideoCount: data.totals.deniedVideoCount ?? 0,
        approvedApplicantCount: data.totals.approvedApplicantCount ?? 0,
        deniedApplicantCount: data.totals.deniedApplicantCount ?? 0,
        erroredVideoAttemptCount: data.totals.erroredVideoAttemptCount ?? 0,
        failureReasonBreakdown: data.failureReasonBreakdown ?? [],
        deniedPassportRows: baseDenied,
      };
    }
    return computeFilteredTopStats(data.reportEvents, passportRoutes, emailToRoute, routeFilter, baseDenied);
  }, [data, routeFilter, passportRoutes, emailToRoute]);

  const deniedRecoveryByEmail = useMemo((): Record<string, DeniedEmailRecovery> => {
    if (!data?.reportEvents) return data?.deniedRecoveryByEmail ?? {};
    const { statusVideos, inHousePassed } = data.reportEvents;
    if (!isRouteFilterActive(routeFilter)) {
      return data.deniedRecoveryByEmail ?? computeDeniedRecoveryByEmail(statusVideos, inHousePassed);
    }
    const routesByKey = indexPassportRoutes(passportRoutes);
    const sv = statusVideos.filter((e) =>
      eventMatchesRouteFilter(e.email, e.passportNumber, routesByKey, emailToRoute, routeFilter)
    );
    const ih = inHousePassed.filter((e) =>
      eventMatchesRouteFilter(e.email, e.passportNumber, routesByKey, emailToRoute, routeFilter)
    );
    return computeDeniedRecoveryByEmail(sv, ih);
  }, [data, routeFilter, passportRoutes, emailToRoute]);

  const routeFilterActive = isRouteFilterActive(routeFilter);

  const unresolvedEmails =
    data?.applicantOutcomes
      ?.filter((o) => o.outcome === "pending")
      .map((o) => o.email)
      .sort((a, b) => a.localeCompare(b)) ?? [];

  function applyPreset(interval: string) {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["24h"];
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    setFromStr(toDatetimeLocal(from));
    setToStr(toDatetimeLocal(to));
  }

  async function handleGenerate() {
    setError(null);
    setLoading(true);
    setData(null);
    setRouteFilter(EMPTY_ROUTE_FILTER);
    setPassportRoutes([]);
    setEmailToRoute(new Map());
    setRouteFilterOptions(null);
    setRouteCombinations([]);
    setRoutesError(null);

    const fromMs = new Date(fromStr).getTime();
    const toMs = new Date(toStr).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      setError("From must be before To (use valid date-time).");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/approved-videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromMs,
          to: toMs,
          target: target.trim() || "vfs-global-bot",
          solveKind,
          deploymentEnv,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as Partial<ApiResponse> & { error?: string };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        setLoading(false);
        return;
      }
      setData(json as ApiResponse);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">In-house verification outcomes</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Top cards count raw VFS lines in the window: videos from{" "}
          <code className="text-xs">appointment/idnfystatus</code> response lines (
          <code className="text-xs">APPROVED</code> / <code className="text-xs">DENIED</code>
          ), applicants from <code className="text-xs">In-house verification passed</code> and{" "}
          <code className="text-xs">/idnfystatus never returned APPROVED</code>. Errored video attempts:{" "}
          <code className="text-xs">Attempt … failed (</code>. Cohort outcomes below still filter by activation + Azure job
          type (drop vs verification).
        </p>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 space-y-4">
        <div>
          <span className="block text-sm font-medium text-zinc-700 mb-2">Environment</span>
          <div className="flex gap-2 flex-wrap" role="group" aria-label="Deployment environment">
            {(
              [
                { id: "prod" as const, label: "Production" },
                { id: "staging" as const, label: "Staging" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setDeploymentEnv(opt.id)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  deploymentEnv === opt.id
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-300 text-zinc-700 hover:bg-zinc-50"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="block text-sm font-medium text-zinc-700 mb-2">Report job type</span>
          <div className="flex gap-2 flex-wrap" role="group" aria-label="Solve kind">
            {(
              [
                { id: "drop" as const, label: "Drop solves" },
                { id: "verification" as const, label: "Verification solves" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setSolveKind(opt.id)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  solveKind === opt.id
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-300 text-zinc-700 hover:bg-zinc-50"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">From</label>
          <input
            type="datetime-local"
            value={fromStr}
            onChange={(e) => setFromStr(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">To</label>
          <input
            type="datetime-local"
            value={toStr}
            onChange={(e) => setToStr(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
        </div>
        <div className="sm:col-span-2 flex flex-col justify-end">
          <label className="block text-sm font-medium text-zinc-700 mb-1">Quick range</label>
          <div className="flex gap-2 flex-wrap">
            {(["15m", "1h", "6h", "24h"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => applyPreset(v)}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                Last {v}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">Target app label</label>
          <input
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="vfs-global-bot"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={loading}
        className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {loading ? "Loading..." : "Run report"}
      </button>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {data && (
        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
            <div>
              Window: <span className="font-medium">{fmtTime(new Date(data.from).toISOString())}</span> →{" "}
              <span className="font-medium">{fmtTime(new Date(data.to).toISOString())}</span>
              {data.vfsCorrelationApp ? (
                <>
                  {" "}
                  · VFS app <code>{data.vfsCorrelationApp}</code>
                  {data.vfsLokiNamespace ? (
                    <>
                      {" "}
                      · Loki <code>namespace={data.vfsLokiNamespace}</code>
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Environment:{" "}
              <span className="font-medium text-zinc-700">
                {data.deploymentEnv === "staging" ? "Staging" : "Production"}
              </span>
              {" · "}
              Report:{" "}
              <span className="font-medium text-zinc-700">
                {data.solveKind === "verification" ? "Verification solves" : "Drop solves"}
              </span>
              {data.azureCorrelationApp ? (
                <>
                  {" "}
                  · Azure <code>{data.azureCorrelationApp}</code>
                </>
              ) : null}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Applicants: <span className="font-medium text-zinc-700">{data.totals.applicantCount}</span> · VFS solving
              lines (included / raw): {data.totals.solvingLogLines} /{" "}
              {data.totals.solvingLogLinesRaw ?? "—"} · identity query / outcome lines:{" "}
              {data.totals.identityVerificationLogLines ?? "—"} / {data.totals.identityOutcomeLogLines ?? "—"} ·
              success / fail lines: {data.totals.successLogLines} / {data.totals.failLogLines} · solver lines:{" "}
              {data.totals.solverLogLines ?? "—"}
              {data.totals.azureLivenessLogLines != null ? (
                <>
                  {" "}
                  · Azure liveness lines: {data.totals.azureLivenessLogLines} (session prefixes mapped:{" "}
                  {data.totals.azureSessionPrefixesMapped ?? "—"})
                </>
              ) : null}
            </div>
            {(data.totals.solvingExcludedNoTaskId ?? 0) +
              (data.totals.solvingExcludedNoAzureMatch ?? 0) +
              (data.totals.solvingExcludedWrongKind ?? 0) >
              0 && (
              <div className="mt-1 text-[11px] text-zinc-500">
                Excluded VFS solving lines: no TaskId {data.totals.solvingExcludedNoTaskId ?? 0}, no Azure match{" "}
                {data.totals.solvingExcludedNoAzureMatch ?? 0}, other job type {data.totals.solvingExcludedWrongKind ?? 0}
              </div>
            )}
            <div className="mt-1 text-[11px] text-zinc-500">
              idnfystatus Loki lines (raw / matched response): {data.totals.idnfyStatusRawLogLines ?? "—"} /{" "}
              {data.totals.idnfyStatusResponseLogLines ?? "—"} · errored attempt lines:{" "}
              {data.totals.erroredVideoAttemptCount ?? "—"}
            </div>
            <div className="mt-1 text-[11px] text-zinc-500">
              Azure payload logs: {data.totals.azurePayloadLogLines ?? 0} · correlated rows{" "}
              {data.totals.taskPayloadRows ?? 0} (via VFS solving TaskId prefix) ·{" "}
              <code>[RESULT] FAILED</code> lines: {data.totals.azureResultFailedLogLines ?? 0} · InvalidToken jobs
              (prefix match): {data.totals.azureInvalidTokenJobCount ?? 0}
            </div>
          </div>

          <div className="rounded-lg border border-blue-200 bg-blue-50/60 px-4 py-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-zinc-800">Filter stats by dashboard route</p>
              {routeFilterActive ? (
                <span className="text-xs font-medium text-blue-900">Filtered</span>
              ) : (
                <span className="text-xs text-zinc-600">All routes (no filter)</span>
              )}
            </div>
            {!dashboardJwtSaved ? (
              <p className="text-xs text-zinc-600">
                Sign in with dashboard OTP in the DENIED passports section below to load routes and enable filtering.
              </p>
            ) : routesLoading ? (
              <p className="text-xs text-zinc-600">Loading passport routes from dashboard…</p>
            ) : routesError ? (
              <p className="text-xs text-red-700">{routesError}</p>
            ) : routeFilterOptions ? (
              <p className="text-xs text-zinc-500">
                {passportRoutes.length} route(s) in this report on dashboard · pick one combined route or use separate
                dropdowns (empty = all)
              </p>
            ) : null}
            {routeFilterActive && filtered?.routeFilterCoverage ? (
              <p className="text-xs text-amber-900 bg-amber-50 border border-amber-100 rounded px-2 py-1">
                Approved videos in filter: {filtered.routeFilterCoverage.approvedVideosMatched} of{" "}
                {filtered.routeFilterCoverage.approvedVideosTotal}
                {filtered.routeFilterCoverage.unmatchedOnDashboard > 0
                  ? ` (${filtered.routeFilterCoverage.unmatchedOnDashboard} have no dashboard route — excluded)`
                  : null}
              </p>
            ) : null}
            {routeCombinations.length > 0 ? (
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Route (from → to · category)</label>
                <select
                  value={
                    routeFilter.fromCountry || routeFilter.toCountry || routeFilter.subVisaCategoryName
                      ? `${routeFilter.fromCountry}|${routeFilter.toCountry}|${routeFilter.subVisaCategoryName}`
                      : ""
                  }
                  onChange={(e) => {
                    const id = e.target.value;
                    if (!id) {
                      setRouteFilter(EMPTY_ROUTE_FILTER);
                      return;
                    }
                    const combo = routeCombinations.find((c) => c.id === id);
                    if (!combo) return;
                    setRouteFilter({
                      fromCountry: combo.fromCountry,
                      toCountry: combo.toCountry,
                      subVisaCategoryName: combo.subVisaCategoryName,
                    });
                  }}
                  className="w-full rounded-lg border border-zinc-300 px-2 py-2 text-sm bg-white"
                >
                  <option value="">All routes</option>
                  {routeCombinations.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">From country</label>
                <select
                  value={routeFilter.fromCountry}
                  onChange={(e) => setRouteFilter((f) => ({ ...f, fromCountry: e.target.value }))}
                  disabled={!routeFilterOptions}
                  className="w-full rounded-lg border border-zinc-300 px-2 py-2 text-sm bg-white disabled:opacity-50"
                >
                  <option value="">All</option>
                  {(routeFilterOptions?.fromCountries ?? []).map((c) => (
                    <option key={c} value={c}>
                      {c.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">To country</label>
                <select
                  value={routeFilter.toCountry}
                  onChange={(e) => setRouteFilter((f) => ({ ...f, toCountry: e.target.value }))}
                  disabled={!routeFilterOptions}
                  className="w-full rounded-lg border border-zinc-300 px-2 py-2 text-sm bg-white disabled:opacity-50"
                >
                  <option value="">All</option>
                  {(routeFilterOptions?.toCountries ?? []).map((c) => (
                    <option key={c} value={c}>
                      {c.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Sub visa category</label>
                <select
                  value={routeFilter.subVisaCategoryName}
                  onChange={(e) => setRouteFilter((f) => ({ ...f, subVisaCategoryName: e.target.value }))}
                  disabled={!routeFilterOptions}
                  className="w-full rounded-lg border border-zinc-300 px-2 py-2 text-sm bg-white disabled:opacity-50"
                >
                  <option value="">All</option>
                  {(routeFilterOptions?.subVisaCategories ?? []).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {routeFilterActive ? (
              <button
                type="button"
                onClick={() => setRouteFilter(EMPTY_ROUTE_FILTER)}
                className="text-xs text-blue-800 underline"
              >
                Clear route filter
              </button>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-5">
              <div className="text-sm font-medium text-emerald-900">Approved videos</div>
              <div className="mt-1 text-3xl font-semibold text-emerald-950">
                {filtered?.approvedVideoCount ?? 0}
              </div>
              <div className="mt-1 text-xs text-emerald-800">
                <code className="text-[10px]">idnfystatus</code> · <code className="text-[10px]">status:APPROVED</code>
              </div>
            </div>
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-5">
              <div className="text-sm font-medium text-emerald-900">Approved applicants</div>
              <div className="mt-1 text-3xl font-semibold text-emerald-950">
                {filtered?.approvedApplicantCount ?? 0}
              </div>
              <div className="mt-1 text-xs text-emerald-800">
                <code className="text-[10px]">In-house verification passed</code>
              </div>
            </div>
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-5">
              <div className="text-sm font-medium text-rose-900">Denied videos</div>
              <div className="mt-1 text-3xl font-semibold text-rose-950">{filtered?.deniedVideoCount ?? 0}</div>
              <div className="mt-1 text-xs text-rose-800">
                <code className="text-[10px]">idnfystatus</code> · <code className="text-[10px]">status:DENIED</code>
              </div>
            </div>
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-5">
              <div className="text-sm font-medium text-rose-900">Denied applicants</div>
              <div className="mt-1 text-3xl font-semibold text-rose-950">
                {filtered?.deniedApplicantCount ?? 0}
              </div>
              <div className="mt-1 text-xs text-rose-800">
                <code className="text-[10px]">/idnfystatus never returned APPROVED</code>
              </div>
              <div className="mt-4 pt-3 border-t border-rose-200/80">
                <div className="text-xs font-medium text-rose-900">Errored video attempts</div>
                <div className="mt-1 text-2xl font-semibold text-rose-950">
                  {filtered?.erroredVideoAttemptCount ?? 0}
                </div>
                <div className="mt-1 text-[11px] text-rose-800">
                  <code className="text-[10px]">Attempt … failed (</code> in window
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
              <div className="text-sm font-medium text-zinc-800">Cohort success</div>
              <div className="mt-1 text-2xl font-semibold text-zinc-950">{data.totals.successCount}</div>
              <div className="mt-1 text-xs text-zinc-600">Activation sessions with terminal pass</div>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
              <div className="text-sm font-medium text-zinc-800">Cohort failed</div>
              <div className="mt-1 text-2xl font-semibold text-zinc-950">{data.totals.failureCount}</div>
              <div className="mt-1 text-xs text-zinc-600">
                Solver attempt failures (failed cohort): {data.totals.terminalFailureLogCount ?? "—"}
              </div>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4">
              <div className="text-sm font-medium text-amber-900">Unresolved</div>
              <div className="mt-1 text-2xl font-semibold text-amber-950">{data.totals.pendingCount}</div>
              <div className="mt-1 text-xs text-amber-800">No terminal outcome in window</div>
              {unresolvedEmails.length > 0 && (
                <div className="mt-3 max-h-24 overflow-auto rounded border border-amber-200 bg-amber-100/40 px-2 py-1">
                  {unresolvedEmails.map((email) => (
                    <div key={email} className="font-mono text-[10px] text-amber-900 break-all">
                      {email}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {(filtered?.failureReasonBreakdown ?? []).length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-zinc-800 mb-2">
                Errored video attempts by reason (<code className="text-[10px]">Attempt … failed</code> in window — same
                total as card above)
              </h2>
              <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
                <table className="min-w-full text-xs">
                  <thead className="bg-zinc-100 text-zinc-800">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">Count</th>
                      <th className="px-3 py-2 text-left font-semibold">Error / message</th>
                      <th className="px-3 py-2 text-left font-semibold">3 random examples</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(filtered?.failureReasonBreakdown ?? []).map((row) => (
                      <tr key={row.reason} className="border-t border-zinc-100 align-top">
                        <td className="px-3 py-2 font-mono font-semibold text-zinc-900 whitespace-nowrap w-16">
                          {row.count}
                        </td>
                        <td className="px-3 py-2 font-mono text-zinc-800 break-all">{row.reason}</td>
                        <td className="px-3 py-2 text-zinc-800">
                          {(row.samples ?? []).length === 0 ? (
                            <span className="text-zinc-500">—</span>
                          ) : (
                            <div className="space-y-2">
                              {(row.samples ?? []).map((s, idx) => (
                                <div key={`${s.email}-${s.passportNumber ?? "na"}-${idx}`} className="text-[11px]">
                                  <div>
                                    <span className="font-semibold">Email:</span> <span className="font-mono">{s.email}</span>
                                  </div>
                                  <div>
                                    <span className="font-semibold">Passport:</span>{" "}
                                    <span className="font-mono">{s.passportNumber ?? "—"}</span>
                                  </div>
                                  <div>
                                    <span className="font-semibold">Video:</span>{" "}
                                    {s.videoLink ? (
                                      <a
                                        href={s.videoLink}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-blue-700 underline break-all"
                                      >
                                        {s.videoLink}
                                      </a>
                                    ) : (
                                      <span className="font-mono">—</span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(filtered?.deniedVideoCount ?? 0) > 0 || (filtered?.deniedPassportRows?.length ?? 0) > 0 ? (
            <DeniedPassportsByPassportSection
              rows={filtered?.deniedPassportRows ?? []}
              passportResolveErrors={data.deniedPassportErrors}
              recoveryByEmail={deniedRecoveryByEmail}
            />
          ) : null}

        </div>
      )}
    </div>
  );
}

