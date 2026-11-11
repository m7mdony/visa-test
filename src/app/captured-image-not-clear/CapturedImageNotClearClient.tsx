"use client";

import { useCallback, useEffect, useState } from "react";
import VisaflowDashboardLoginPanel from "@/components/VisaflowDashboardLoginPanel";
import type { CapturedImageNotClearRow } from "@/lib/capturedImageNotClear";
import {
  applyRefreshedBearerJwt,
  buildDashboardAuthBody,
  useVisaflowDashboardAuth,
} from "@/lib/visaflowDashboardAuth";
import type { GestureClipEntry } from "@/lib/visaflowDashboardPassports";
import { normalizePassportKey } from "@/lib/visaflowDashboardPassports";

const INTERVAL_MS: Record<string, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

type DeploymentEnvUi = "prod" | "staging";

type DashboardPassportEntry = {
  applicantId: string | null;
  applicant?: { firstName?: string; lastName?: string };
  passportImages: Array<{ id: string; url: string }>;
  videos: string[];
  gestureClips: GestureClipEntry[];
  error?: string;
};

type ApiResponse = {
  from: number;
  to: number;
  deploymentEnv: DeploymentEnvUi;
  lokiFilters?: string[];
  totals: {
    lokiLines: number;
    matchedRows: number;
    distinctPassports: number;
  };
  passports: string[];
  rows: CapturedImageNotClearRow[];
  error?: string;
};

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900";

function toDatetimeLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString();
}

function dashEntryFor(
  passportNumber: string | null | undefined,
  byPassport: Record<string, DashboardPassportEntry>
): DashboardPassportEntry | undefined {
  const k = passportNumber?.trim();
  if (!k) return undefined;
  return byPassport[k] ?? byPassport[normalizePassportKey(k)];
}

function VideoCell({ urls, label }: { urls: string[]; label: string }) {
  const list = urls.map((u) => u.trim()).filter(Boolean);
  if (list.length === 0) {
    return <span className="text-zinc-400 text-xs">—</span>;
  }
  return (
    <div className="space-y-3 max-w-[340px]">
      {list.map((url) => (
        <div key={url} className="space-y-1">
          <p className="text-xs text-zinc-500 font-medium">{label}</p>
          <video src={url} controls preload="metadata" className="w-full max-h-52 rounded border border-zinc-200 bg-black" />
          <a href={url} target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 underline break-all">
            open
          </a>
        </div>
      ))}
    </div>
  );
}

const GESTURE_GRID_ORDER = [
  "up",
  "down",
  "left",
  "right",
  "upLeft",
  "upRight",
  "downLeft",
  "downRight",
  "smile",
] as const;

function gestureClipForName(clips: GestureClipEntry[], name: string): GestureClipEntry | null {
  const exact = clips.find((c) => c.gesture === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  return clips.find((c) => c.gesture.toLowerCase() === lower) ?? null;
}

function GestureClipsCell({ clips }: { clips: GestureClipEntry[] }) {
  if (!clips.length) {
    return <span className="text-zinc-400 text-xs">No gesture clips</span>;
  }
  return (
    <div className="grid grid-cols-3 gap-2 w-[min(100%,540px)] min-w-[420px]">
      {GESTURE_GRID_ORDER.map((gesture) => {
        const clip = gestureClipForName(clips, gesture);
        return (
          <div
            key={gesture}
            className="flex flex-col rounded border border-zinc-200 bg-zinc-50/80 overflow-hidden"
          >
            <p className="px-1 py-1 text-[11px] font-semibold text-zinc-600 text-center truncate" title={gesture}>
              {gesture}
            </p>
            {clip ? (
              <video
                src={clip.clipUrl}
                controls
                preload="metadata"
                className="aspect-square w-full object-cover bg-black"
              />
            ) : (
              <div className="aspect-square w-full flex items-center justify-center text-[10px] text-zinc-400 bg-zinc-100">
                —
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function CapturedImageNotClearClient() {
  const now = Date.now();
  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(new Date(now - INTERVAL_MS["24h"])));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(new Date(now)));
  const [deploymentEnv, setDeploymentEnv] = useState<DeploymentEnvUi>("prod");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [dashByPassport, setDashByPassport] = useState<Record<string, DashboardPassportEntry>>({});
  const [dashLoading, setDashLoading] = useState(false);
  const [dashError, setDashError] = useState<string | null>(null);
  const { authenticated: dashboardJwtSaved } = useVisaflowDashboardAuth();

  const fetchDashboardForPassports = useCallback(async (passportNumbers: string[]) => {
    if (passportNumbers.length === 0) return;
    const { bearerJwt: bearerFromStorage, clerkSessionId: refreshSid, clerkCookie: refreshJar, organizationId } =
      buildDashboardAuthBody();
    if (
      (!bearerFromStorage || bearerFromStorage.split(".").length < 2) &&
      !(refreshSid?.startsWith("sess_") && refreshJar)
    ) {
      setDashError("Sign in with Visaflow dashboard OTP first.");
      return;
    }
    setDashError(null);
    setDashLoading(true);
    try {
      const res = await fetch("/api/dashboard-passport-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          passportNumbers,
          bearerJwt: bearerFromStorage,
          ...(refreshSid?.startsWith("sess_") ? { clerkSessionId: refreshSid } : {}),
          ...(refreshJar ? { clerkCookie: refreshJar } : {}),
          ...(organizationId ? { organizationId } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        warning?: string;
        clientsApplicantsScanned?: number;
        clientsCount?: number;
        byPassport?: Record<string, DashboardPassportEntry>;
        refreshedBearerJwt?: string;
      };
      if (!res.ok) {
        const hint =
          json.clientsCount != null
            ? ` (/clients: ${json.clientsCount} clients, ${json.clientsApplicantsScanned ?? 0} applicants)`
            : "";
        setDashError((json.error ?? `HTTP ${res.status}`) + hint);
        return;
      }
      if (json.warning) {
        setDashError(json.warning);
      }
      applyRefreshedBearerJwt(json.refreshedBearerJwt);
      setDashByPassport(json.byPassport ?? {});
    } finally {
      setDashLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!data?.passports?.length || !dashboardJwtSaved) return;
    void fetchDashboardForPassports(data.passports);
  }, [data, dashboardJwtSaved, fetchDashboardForPassports]);

  function applyPreset(interval: string) {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["24h"];
    const to = new Date();
    setFromStr(toDatetimeLocal(new Date(to.getTime() - ms)));
    setToStr(toDatetimeLocal(to));
  }

  async function runSearch() {
    setError(null);
    setLoading(true);
    setData(null);
    setDashByPassport({});
    setDashError(null);

    const from = new Date(fromStr).getTime();
    const to = new Date(toStr).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      setError("From must be before To.");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/captured-image-not-clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, deploymentEnv }),
      });
      const json = (await res.json().catch(() => ({}))) as ApiResponse;
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-6 w-full">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900">Captured image not clear [1093]</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Loki on <code className="text-zinc-800">vfs-global-bot</code> for{" "}
          <code className="text-zinc-800">[1093] The captured image is not clear</code> (idnfystatus). Loads
          passport scan, color videos, and gesture clips from the Visaflow dashboard.
        </p>
      </div>

      <VisaflowDashboardLoginPanel hint="Required to load passport images and videos from /clients." />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-600">From</span>
          <input type="datetime-local" className={inputClass} value={fromStr} onChange={(e) => setFromStr(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-600">To</span>
          <input type="datetime-local" className={inputClass} value={toStr} onChange={(e) => setToStr(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-600">Environment</span>
          <select
            className={inputClass}
            value={deploymentEnv}
            onChange={(e) => setDeploymentEnv(e.target.value === "staging" ? "staging" : "prod")}
          >
            <option value="prod">Production</option>
            <option value="staging">Staging</option>
          </select>
        </label>
        <div className="flex flex-col justify-end gap-2">
          <div className="flex flex-wrap gap-1">
            {(["15m", "1h", "6h", "24h"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => applyPreset(p)}
                className="rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
              >
                {p}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={runSearch}
            disabled={loading}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {loading ? "Searching…" : "Run search"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}
      {dashError && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {dashError}
        </div>
      )}

      {data && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-700">
            <span>
              <strong>{data.totals.matchedRows}</strong> events ·{" "}
              <strong>{data.totals.distinctPassports}</strong> passports · {data.totals.lokiLines} Loki lines
            </span>
            {data.passports.length > 0 && (
              <button
                type="button"
                disabled={dashLoading || !dashboardJwtSaved}
                onClick={() => void fetchDashboardForPassports(data.passports)}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
              >
                {dashLoading ? "Loading dashboard…" : "Reload dashboard media"}
              </button>
            )}
          </div>

          {rows.length === 0 ? (
            <p className="text-sm text-zinc-600">No [1093] captured-image lines in this window.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-zinc-200">
              <table className="min-w-full text-sm">
                <thead className="bg-zinc-50 text-left text-xs font-semibold text-zinc-600">
                  <tr>
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2">Passport</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Route</th>
                    <th className="px-3 py-2 min-w-[220px]">Passport image</th>
                    <th className="px-3 py-2 min-w-[320px]">Color videos</th>
                    <th className="px-3 py-2 min-w-[540px]">Gesture clips (3×3)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {rows.map((row, i) => {
                    const dash = dashEntryFor(row.passportNumber, dashByPassport);
                    const passportImg = dash?.passportImages?.[0]?.url;
                    const colorVideos = dash?.videos ?? [];
                    return (
                      <tr key={`${row.time}-${row.passportNumber}-${i}`} className="align-top">
                        <td className="px-3 py-2 whitespace-nowrap text-xs text-zinc-700">{fmtTime(row.time)}</td>
                        <td className="px-3 py-2 font-mono text-xs">{row.passportNumber ?? "—"}</td>
                        <td className="px-3 py-2 text-xs break-all max-w-[180px]">{row.email ?? "—"}</td>
                        <td className="px-3 py-2 text-xs text-zinc-600">
                          {row.fromCountry && row.toCountry ? `${row.fromCountry} → ${row.toCountry}` : "—"}
                        </td>
                        <td className="px-3 py-2">
                          {!row.passportNumber?.trim() ? (
                            <span className="text-amber-700 text-xs">No passport in log</span>
                          ) : !dash ? (
                            <span className="text-zinc-400 text-xs">Load dashboard</span>
                          ) : dash.error ? (
                            <span className="text-red-600 text-[10px] break-words">{dash.error}</span>
                          ) : passportImg ? (
                            <a href={passportImg} target="_blank" rel="noreferrer" className="inline-block">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={passportImg}
                                alt=""
                                className="h-44 max-w-[220px] object-cover rounded border border-zinc-200"
                                loading="lazy"
                                referrerPolicy="no-referrer"
                              />
                            </a>
                          ) : (
                            <span className="text-zinc-500 text-xs">No image</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {!dash ? (
                            <span className="text-zinc-400 text-xs">Load dashboard</span>
                          ) : (
                            <VideoCell urls={colorVideos} label="color" />
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {!dash ? (
                            <span className="text-zinc-400 text-xs">Load dashboard</span>
                          ) : (
                            <GestureClipsCell clips={dash.gestureClips ?? []} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
