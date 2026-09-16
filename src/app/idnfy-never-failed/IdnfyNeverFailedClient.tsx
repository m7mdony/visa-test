"use client";

import { useMemo, useState } from "react";
import type { IdnfyNeverFailedRow } from "@/lib/idnfyNeverFailedVideos";

const INTERVAL_MS: Record<string, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

type DeploymentEnvUi = "prod" | "staging";

type ApiResponse = {
  from: number;
  to: number;
  deploymentEnv: DeploymentEnvUi;
  solverApp: string;
  totals: {
    vfsFailQueryLines: number;
    vfsMatchedFailures: number;
    vfsActivationQueryLines: number;
    solverResultQueryLines: number;
    withToken: number;
    withVideos: number;
    unresolved: number;
  };
  rows: IdnfyNeverFailedRow[];
  error?: string;
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
  return d.toLocaleString();
}

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900";

export default function IdnfyNeverFailedClient() {
  const now = Date.now();
  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(new Date(now - INTERVAL_MS["24h"])));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(new Date(now)));
  const [deploymentEnv, setDeploymentEnv] = useState<DeploymentEnvUi>("prod");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);

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

    const from = new Date(fromStr).getTime();
    const to = new Date(toStr).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      setError("From must be before To.");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/idnfy-never-failed", {
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
  const filteredSummary = useMemo(() => {
    if (!data) return null;
    const successSolves = rows.reduce(
      (n, r) => n + r.solves.filter((s) => s.success && s.recordedVideoUrl).length,
      0
    );
    const failedSolves = rows.reduce(
      (n, r) => n + r.solves.filter((s) => !s.success).length,
      0
    );
    return { successSolves, failedSolves };
  }, [data, rows]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900">Idnfystatus never — reset videos</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Finds{" "}
          <code className="text-zinc-800">
            Identity verification failed … record new videos … /idnfystatus never returned APPROVED
          </code>
          , then resolves email → activation token → solver video URLs (1–3 attempts).
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-600">From</span>
          <input
            type="datetime-local"
            className={inputClass}
            value={fromStr}
            onChange={(e) => setFromStr(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-600">To</span>
          <input
            type="datetime-local"
            className={inputClass}
            value={toStr}
            onChange={(e) => setToStr(e.target.value)}
          />
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
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {data && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Matched failures" value={data.totals.vfsMatchedFailures} />
          <StatCard label="With token" value={data.totals.withToken} />
          <StatCard label="With video URLs" value={data.totals.withVideos} />
          <StatCard label="Unresolved" value={data.totals.unresolved} />
          {filteredSummary && (
            <StatCard
              label="Solver attempts"
              value={`${filteredSummary.successSolves} ok / ${filteredSummary.failedSolves} fail`}
            />
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-zinc-200">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2">Failed at</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Passport</th>
                <th className="px-3 py-2">Route</th>
                <th className="px-3 py-2">Token</th>
                <th className="min-w-[280px] px-3 py-2">Videos</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((row) => (
                <Row key={`${row.email}|${row.failedAt}|${row.urn ?? ""}`} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && rows.length === 0 && !loading && (
        <p className="text-sm text-zinc-500">No matching idnfystatus-never failures in this window.</p>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-zinc-900">{value}</div>
    </div>
  );
}

function Row({ row }: { row: IdnfyNeverFailedRow }) {
  const route =
    row.fromCountry && row.toCountry ? `${row.fromCountry} → ${row.toCountry}` : "—";
  const tokenShort = row.token ? `${row.token.slice(0, 8)}…` : "—";

  return (
    <tr className="align-top hover:bg-zinc-50/80">
      <td className="whitespace-nowrap px-3 py-2 text-zinc-700">{fmtTime(row.failedAt)}</td>
      <td className="px-3 py-2 text-zinc-900">{row.email}</td>
      <td className="px-3 py-2 font-mono text-xs text-zinc-700">{row.passportNumber ?? "—"}</td>
      <td className="px-3 py-2 text-zinc-600">{route}</td>
      <td className="px-3 py-2 font-mono text-xs text-zinc-600" title={row.token ?? undefined}>
        {tokenShort}
      </td>
      <td className="px-3 py-2">
        {row.solves.length === 0 ? (
          <span className="text-xs text-amber-700">{row.unresolvedReason ?? "—"}</span>
        ) : (
          <div className="space-y-2">
            {row.solves.map((s) => (
              <div key={s.resultId} className="text-xs">
                <span
                  className={`mr-2 inline-flex rounded-full px-2 py-0.5 font-medium ${
                    s.success ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
                  }`}
                >
                  #{s.attempt} {s.success ? "ok" : "fail"}
                </span>
                {s.recordedVideoUrl ? (
                  <a
                    href={s.recordedVideoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-blue-600 hover:underline"
                  >
                    {s.recordedVideoUrl}
                  </a>
                ) : (
                  <span className="text-zinc-400">No video URL</span>
                )}
              </div>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}
