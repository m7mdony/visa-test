"use client";

import { useEffect, useMemo, useState } from "react";
import type { DeniedPassportRow } from "@/lib/deniedPassports";
import type { DeniedEmailRecovery } from "@/lib/deniedRecovery";
import {
  buildStagingJobsForAllPassports,
  buildStagingJobsForPassport,
} from "@/lib/stagingJobBatches";

import {
  applyRefreshedBearerJwt,
  buildDashboardAuthBody,
  useVisaflowDashboardAuth,
} from "@/lib/visaflowDashboardAuth";

type DashboardPassportEntry = {
  applicantId: string | null;
  applicant?: { firstName?: string; lastName?: string; status?: string };
  passportImages: Array<{ id: string; url: string }>;
  videos?: string[];
  error?: string;
};

export type PassportGroupRow = {
  passportNumber: string | null;
  deniedCount: number;
  latestDeniedAt: string;
  emails: string[];
  urns: string[];
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString();
}

function EmailRecoveryLine({ email, recovery }: { email: string; recovery?: DeniedEmailRecovery }) {
  const r = recovery;
  return (
    <li className="space-y-0.5">
      <span className="font-mono break-all">{email}</span>
      {r ? (
        <div className="text-[10px] pl-0">
          {r.recoveredAfterLatestDenied ? (
            <span className="text-emerald-800">
              Recovered — in-house pass
              {r.recoveredAt ? ` · ${fmtTime(r.recoveredAt)}` : ""}
              {r.deniedEventCount > 1
                ? ` (${r.deniedEventsRecovered}/${r.deniedEventCount} DENIED→pass)`
                : null}
            </span>
          ) : (
            <span className="text-rose-800">
              Not recovered — no in-house pass after DENIED
              {r.deniedEventCount > 1 ? ` (${r.deniedEventCount} DENIED)` : null}
            </span>
          )}
        </div>
      ) : (
        <div className="text-[10px] text-zinc-500">No DENIED idnfystatus in window for this email</div>
      )}
    </li>
  );
}

function VideosCell({ entry }: { entry?: DashboardPassportEntry }) {
  if (!entry || entry.error) return <span className="text-zinc-400 text-xs">—</span>;
  const videos = entry.videos ?? [];
  if (videos.length === 0) {
    return <span className="text-zinc-500 text-[10px]">No videos on dashboard</span>;
  }
  return (
    <div className="space-y-2 max-w-[300px]">
      <ul className="space-y-1">
        {videos.map((url, i) => (
          <li key={`${url}-${i}`}>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-blue-700 underline break-all text-[10px] font-mono"
            >
              {videos.length > 1 ? `Video ${i + 1}` : "Open video"}
            </a>
          </li>
        ))}
      </ul>
      <video
        src={videos[0]}
        controls
        preload="metadata"
        className="max-h-28 max-w-full rounded border border-zinc-200 bg-black"
      />
    </div>
  );
}

function CopyPassportStagingJsonButton({
  passportNumber,
  entry,
}: {
  passportNumber: string | null;
  entry?: DashboardPassportEntry;
}) {
  const [copied, setCopied] = useState(false);
  const { jobs, error } = useMemo(() => {
    if (!passportNumber?.trim()) return { jobs: [], error: "No passport" };
    return buildStagingJobsForPassport(passportNumber, entry);
  }, [passportNumber, entry]);

  async function copy() {
    if (jobs.length === 0) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(jobs, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  if (!passportNumber?.trim()) return <span className="text-zinc-400 text-xs">—</span>;

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={copy}
        disabled={jobs.length === 0}
        title={error ?? undefined}
        className="rounded border border-zinc-300 bg-white px-2 py-1 text-[10px] font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {copied ? "Copied" : jobs.length > 0 ? `Copy ${jobs.length} job${jobs.length === 1 ? "" : "s"}` : "Copy JSON"}
      </button>
      {error ? <p className="text-[10px] text-amber-800 max-w-[140px]">{error}</p> : null}
    </div>
  );
}

function PassportCell({
  passportNumber,
  entry,
}: {
  passportNumber: string | null;
  entry?: DashboardPassportEntry;
}) {
  if (!passportNumber?.trim()) return <span className="text-amber-700 text-xs">No passport in logs</span>;
  if (!entry) return <span className="text-zinc-400 text-xs">—</span>;
  if (entry.error) {
    return <span className="text-red-600 text-[10px] break-words max-w-[180px] inline-block">{entry.error}</span>;
  }
  if (!entry.passportImages.length) {
    return <span className="text-zinc-500 text-[10px]">No images on dashboard</span>;
  }
  const im = entry.passportImages[0];
  const name =
    entry.applicant &&
    [entry.applicant.firstName, entry.applicant.lastName].filter(Boolean).join(" ").trim();
  return (
    <div className="space-y-1 max-w-[200px]">
      {name ? <p className="text-[10px] text-zinc-600 font-medium break-words">{name}</p> : null}
      <a href={im.url} target="_blank" rel="noreferrer" className="inline-block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={im.url}
          alt="Passport"
          className="h-20 max-w-[140px] object-cover rounded border border-zinc-200 bg-zinc-50"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      </a>
    </div>
  );
}

export function groupDeniedRowsByPassport(rows: DeniedPassportRow[]): PassportGroupRow[] {
  type Acc = { emails: Set<string>; timesMs: number[]; urns: Set<string> };
  const map = new Map<string, Acc>();

  for (const r of rows) {
    const bucketKey = r.passportNumber?.trim() ? r.passportNumber.trim() : "__no_passport__";
    let acc = map.get(bucketKey);
    if (!acc) {
      acc = { emails: new Set(), timesMs: [], urns: new Set() };
      map.set(bucketKey, acc);
    }
    acc.emails.add(r.email);
    const t = Date.parse(r.deniedAt);
    acc.timesMs.push(Number.isFinite(t) ? t : 0);
    const urn = (r.aurn ?? r.urn)?.trim();
    if (urn) acc.urns.add(urn);
  }

  const out: PassportGroupRow[] = [];
  for (const [bucketKey, acc] of map) {
    const passportNumber = bucketKey === "__no_passport__" ? null : bucketKey;
    const times = acc.timesMs.filter((x) => x > 0);
    const latestMs = times.length ? Math.max(...times) : 0;
    const deniedCount = rows.filter((r) =>
      passportNumber ? r.passportNumber?.trim() === passportNumber : !r.passportNumber?.trim()
    ).length;
    out.push({
      passportNumber,
      deniedCount,
      latestDeniedAt: latestMs ? new Date(latestMs).toISOString() : "",
      emails: [...acc.emails].sort(),
      urns: [...acc.urns].sort(),
    });
  }

  out.sort((a, b) => {
    if (b.deniedCount !== a.deniedCount) return b.deniedCount - a.deniedCount;
    if (!a.passportNumber && !b.passportNumber) return 0;
    if (!a.passportNumber) return 1;
    if (!b.passportNumber) return -1;
    return a.passportNumber.localeCompare(b.passportNumber);
  });
  return out;
}

type Props = {
  rows: DeniedPassportRow[];
  passportResolveErrors?: string[];
  recoveryByEmail?: Record<string, DeniedEmailRecovery>;
};

export default function DeniedPassportsByPassportSection({
  rows,
  passportResolveErrors,
  recoveryByEmail = {},
}: Props) {
  const [dashByPassport, setDashByPassport] = useState<Record<string, DashboardPassportEntry>>({});
  const [dashError, setDashError] = useState<string | null>(null);
  const { authenticated: dashboardJwtSaved } = useVisaflowDashboardAuth();
  const [allJobsCopied, setAllJobsCopied] = useState(false);

  const groupedByPassport = useMemo(() => groupDeniedRowsByPassport(rows), [rows]);
  const passportNums = [
    ...new Set(rows.map((r) => r.passportNumber?.trim()).filter((p): p is string => Boolean(p))),
  ];

  async function fetchDashboardImages(passportNumbers: string[]) {
    if (passportNumbers.length === 0) {
      setDashError("No passport numbers to load.");
      return;
    }
    setDashError(null);
    const { bearerJwt: bearerFromStorage, clerkSessionId: refreshSid, clerkCookie: refreshJar } =
      buildDashboardAuthBody();
    if (!bearerFromStorage || bearerFromStorage.split(".").length < 2) {
      setDashError("Sign in with Visaflow dashboard OTP first (panel at top of page).");
      return;
    }
    const res = await fetch("/api/dashboard-passport-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        passportNumbers,
        bearerJwt: bearerFromStorage,
        ...(refreshSid?.startsWith("sess_") ? { clerkSessionId: refreshSid } : {}),
        ...(refreshJar ? { clerkCookie: refreshJar } : {}),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
      byPassport?: Record<string, DashboardPassportEntry>;
      refreshedBearerJwt?: string;
    };
    if (!res.ok) {
      setDashError(json.error ?? `HTTP ${res.status}`);
      return;
    }
    applyRefreshedBearerJwt(json.refreshedBearerJwt);
    setDashByPassport(json.byPassport ?? {});
  }

  useEffect(() => {
    if (rows.length === 0 || !dashboardJwtSaved || passportNums.length === 0) return;
    void fetchDashboardImages(passportNums);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load when rows/JWT ready
  }, [rows, dashboardJwtSaved]);

  async function copyAllPassportJobs() {
    const jobs = buildStagingJobsForAllPassports(dashByPassport);
    if (jobs.length === 0) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(jobs, null, 2));
      setAllJobsCopied(true);
      setTimeout(() => setAllJobsCopied(false), 1500);
    } catch {
      setAllJobsCopied(false);
    }
  }

  return (
    <div className="space-y-4">
      {!dashboardJwtSaved ? (
        <p className="text-xs text-zinc-600 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          Sign in with Visaflow dashboard OTP at the top of the page to load passport images and videos.
        </p>
      ) : null}

      {passportResolveErrors?.length ? (
        <p className="text-xs text-amber-800">{passportResolveErrors.join(" | ")}</p>
      ) : null}
      {dashError ? (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-md px-3 py-2">{dashError}</p>
      ) : null}

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h2 className="text-sm font-medium text-zinc-800">
            DENIED videos by passport{" "}
            <span className="font-normal text-zinc-500">
              (passport, dashboard image, videos, staging JSON per passport)
            </span>
          </h2>
          {Object.keys(dashByPassport).length > 0 ? (
            <button
              type="button"
              onClick={copyAllPassportJobs}
              disabled={buildStagingJobsForAllPassports(dashByPassport).length === 0}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-40"
            >
              {allJobsCopied ? "Copied all" : "Copy all passports (JOBS array)"}
            </button>
          ) : null}
        </div>
        <div className="overflow-auto rounded-xl border border-zinc-200">
          <table className="min-w-full text-sm">
            <thead className="bg-zinc-50 border-b border-zinc-200 text-left text-zinc-700">
              <tr>
                <th className="px-3 py-2 font-medium">Passport</th>
                <th className="px-3 py-2 font-medium">DENIED events</th>
                <th className="px-3 py-2 font-medium">Latest denied</th>
                <th className="px-3 py-2 font-medium">Dashboard videos</th>
                <th className="px-3 py-2 font-medium">Staging JSON</th>
                <th className="px-3 py-2 font-medium">Emails · recovery</th>
                <th className="px-3 py-2 font-medium">URNs</th>
              </tr>
            </thead>
            <tbody>
              {groupedByPassport.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-zinc-500 text-center">
                    No DENIED events with passport data in this range.
                  </td>
                </tr>
              ) : (
                groupedByPassport.map((g) => (
                  <tr key={g.passportNumber ?? "__no_passport__"} className="border-b border-zinc-100 align-top">
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs font-semibold text-zinc-900">
                        {g.passportNumber ?? <span className="text-amber-700">(no passport in logs)</span>}
                      </div>
                      <div className="mt-2">
                        <PassportCell
                          passportNumber={g.passportNumber}
                          entry={g.passportNumber ? dashByPassport[g.passportNumber] : undefined}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs tabular-nums">{g.deniedCount}</td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      {g.latestDeniedAt ? fmtTime(g.latestDeniedAt) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <VideosCell entry={g.passportNumber ? dashByPassport[g.passportNumber] : undefined} />
                    </td>
                    <td className="px-3 py-2">
                      <CopyPassportStagingJsonButton
                        passportNumber={g.passportNumber}
                        entry={g.passportNumber ? dashByPassport[g.passportNumber] : undefined}
                      />
                    </td>
                    <td className="px-3 py-2 text-xs max-w-[280px]">
                      <ul className="list-none space-y-2">
                        {g.emails.map((e) => (
                          <EmailRecoveryLine
                            key={e}
                            email={e}
                            recovery={recoveryByEmail[e.trim().toLowerCase()]}
                          />
                        ))}
                      </ul>
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-zinc-600 max-w-[160px] break-all">
                      {g.urns.length ? g.urns.join(", ") : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
