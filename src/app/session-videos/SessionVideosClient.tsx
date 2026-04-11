"use client";

import { useState } from "react";

type SolveKindUi = "drop" | "verification";

type VideoRow = { email: string; videoLink: string | null; passportNumber: string | null };
type NotAcceptedRow = VideoRow & { failureReason: string };

type ApiResponse = {
  from: number;
  to: number;
  solveKind?: SolveKindUi;
  sessionVideoApprovedRows?: VideoRow[];
  sessionVideoNotAcceptedRows?: NotAcceptedRow[];
  error?: string;
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

export default function SessionVideosClient() {
  const now = Date.now();
  const defaultFrom = new Date(now - INTERVAL_MS["24h"]);
  const defaultTo = new Date(now);
  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(defaultFrom));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(defaultTo));
  const [target, setTarget] = useState("vfs-global-bot");
  const [solveKind, setSolveKind] = useState<SolveKindUi>("drop");
  const [streamKeySuffix, setStreamKeySuffix] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [runKey, setRunKey] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  function applyPreset(interval: string) {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["24h"];
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    setFromStr(toDatetimeLocal(from));
    setToStr(toDatetimeLocal(to));
  }

  async function handleLoad() {
    setError(null);
    setLoading(true);
    setData(null);

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
          includeVideoSessionRows: true,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as ApiResponse & { error?: string };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        setLoading(false);
        return;
      }
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  async function runTestSession(videoUrl: string) {
    const suffix = streamKeySuffix.trim();
    if (!suffix) {
      setRunError("Set stream key ID (last segment) first.");
      return;
    }
    if (!videoUrl) return;
    setRunError(null);
    const key = `${videoUrl}|${suffix}`;
    setRunKey(key);
    try {
      const res = await fetch("/api/approved-videos/run-one", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl, streamKeySuffix: suffix }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; success?: boolean; streamKey?: string };
      if (!res.ok) {
        setRunError(json.error ?? `HTTP ${res.status}`);
        return;
      }
    } catch (e: unknown) {
      setRunError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setRunKey(null);
    }
  }

  const approved = data?.sessionVideoApprovedRows ?? [];
  const notAccepted = data?.sessionVideoNotAcceptedRows ?? [];

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Session video queues</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Same cohort as Approved videos: successful applicants vs vfs-global-bot failures whose message contains{" "}
          <code className="text-xs">status not approved</code> (e.g.{" "}
          <code className="text-xs">Identity verification failed (status not approved)</code>). Each row can enqueue one
          job on Redis stream <code className="text-xs">azure:identity-verification:stream:</code>
          <span className="font-mono text-xs">…</span> using the ID field below (same as{" "}
          <code className="text-xs">test-session.js</code>).
        </p>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
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
        <div className="lg:col-span-2">
          <label className="block text-sm font-medium text-zinc-700 mb-1">
            Stream key ID <span className="text-zinc-500 font-normal">(last path segment)</span>
          </label>
          <input
            type="text"
            value={streamKeySuffix}
            onChange={(e) => setStreamKeySuffix(e.target.value)}
            placeholder="e.g. staging"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white font-mono placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
          <p className="text-xs text-zinc-500 mt-1">
            Full key: <code className="text-[11px]">azure:identity-verification:stream:</code>
            <span className="font-mono text-[11px]">{streamKeySuffix.trim() || "…"}</span>
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={handleLoad}
        disabled={loading}
        className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {loading ? "Loading…" : "Load tables"}
      </button>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
      )}
      {runError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{runError}</p>
      )}

      {data && (
        <div className="space-y-8">
          <section>
            <h2 className="text-sm font-semibold text-zinc-900 mb-2">
              Approved videos <span className="text-zinc-500 font-normal">({approved.length})</span>
            </h2>
            <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
              <table className="min-w-full text-xs">
                <thead className="bg-zinc-100 text-zinc-800">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Video</th>
                    <th className="px-3 py-2 text-left font-semibold">Passport</th>
                    <th className="px-3 py-2 text-left font-semibold w-32">Run test-session</th>
                  </tr>
                </thead>
                <tbody>
                  {approved.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-3 py-4 text-zinc-500">
                        No rows
                      </td>
                    </tr>
                  ) : (
                    approved.map((row) => (
                      <tr key={row.email} className="border-t border-zinc-100 align-top">
                        <td className="px-3 py-2">
                          {row.videoLink ? (
                            <a
                              href={row.videoLink}
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-700 underline break-all font-mono"
                            >
                              {row.videoLink}
                            </a>
                          ) : (
                            <span className="text-zinc-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-zinc-900">{row.passportNumber ?? "—"}</td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            disabled={!row.videoLink || !streamKeySuffix.trim() || runKey !== null}
                            onClick={() => row.videoLink && runTestSession(row.videoLink)}
                            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-40"
                          >
                            {runKey === `${row.videoLink}|${streamKeySuffix.trim()}` ? "Running…" : "Run"}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold text-zinc-900 mb-2">
              Not accepted <span className="text-zinc-500 font-normal">({notAccepted.length})</span>
            </h2>
            <p className="text-xs text-zinc-500 mb-2">
              Only <code className="text-[10px]">In-house identity verification attempt failed</code> lines that
              include <code className="text-[10px]">status not approved</code> in the vfs-global-bot log text.
            </p>
            <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
              <table className="min-w-full text-xs">
                <thead className="bg-zinc-100 text-zinc-800">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Video</th>
                    <th className="px-3 py-2 text-left font-semibold">Passport</th>
                    <th className="px-3 py-2 text-left font-semibold">Reason</th>
                    <th className="px-3 py-2 text-left font-semibold w-32">Run test-session</th>
                  </tr>
                </thead>
                <tbody>
                  {notAccepted.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-4 text-zinc-500">
                        No rows
                      </td>
                    </tr>
                  ) : (
                    notAccepted.map((row, idx) => (
                      <tr
                        key={`${row.email}-${row.failureReason}-${idx}`}
                        className="border-t border-zinc-100 align-top"
                      >
                        <td className="px-3 py-2">
                          {row.videoLink ? (
                            <a
                              href={row.videoLink}
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-700 underline break-all font-mono"
                            >
                              {row.videoLink}
                            </a>
                          ) : (
                            <span className="text-zinc-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-zinc-900">{row.passportNumber ?? "—"}</td>
                        <td className="px-3 py-2 font-mono text-zinc-700 break-all max-w-md">{row.failureReason}</td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            disabled={!row.videoLink || !streamKeySuffix.trim() || runKey !== null}
                            onClick={() => row.videoLink && runTestSession(row.videoLink)}
                            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-40"
                          >
                            {runKey === `${row.videoLink}|${streamKeySuffix.trim()}` ? "Running…" : "Run"}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
