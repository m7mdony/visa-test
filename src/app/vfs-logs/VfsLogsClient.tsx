"use client";

import { useState } from "react";

type LogEntry = { time: string; line: string };

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

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function VfsLogsClient() {
  const now = Date.now();
  const defaultFrom = new Date(now - INTERVAL_MS["1h"]);
  const defaultTo = new Date(now);

  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(defaultFrom));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(defaultTo));
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  function applyPreset(interval: string) {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["1h"];
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    setFromStr(toDatetimeLocal(from));
    setToStr(toDatetimeLocal(to));
  }

  async function handleSearch() {
    setError(null);
    setLoading(true);
    setLogs([]);

    const fromMs = new Date(fromStr).getTime();
    const toMs = new Date(toStr).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      setError("From must be before To (use valid date-time).");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/grafana-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromMs,
          to: toMs,
          target: "vfs-global-bot",
          query: filter.trim(),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { logs?: LogEntry[]; error?: string };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        setLoading(false);
        return;
      }
      setLogs(Array.isArray(json.logs) ? json.logs : []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">VFS logs</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Browse logs from <code>vfs-global-bot</code> with time range and string filter.
        </p>
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
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-700 mb-1">String filter (optional)</label>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder='e.g. status":"DENIED or passportNumber='
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
        />
      </div>

      <button
        type="button"
        onClick={handleSearch}
        disabled={loading}
        className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {loading ? "Searching..." : "Search logs"}
      </button>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
        <div className="px-4 py-2 border-b border-zinc-200 bg-zinc-50 text-sm text-zinc-700">
          Results: <span className="font-medium">{logs.length}</span>
        </div>
        <div className="max-h-[65vh] overflow-auto">
          {logs.length === 0 ? (
            <p className="px-4 py-4 text-sm text-zinc-500">No logs found for this filter and time range.</p>
          ) : (
            <div className="divide-y divide-zinc-100">
              {logs.map((entry, idx) => (
                <div key={`${entry.time}-${idx}`} className="px-4 py-3">
                  <div className="text-xs text-zinc-500">{fmtTime(entry.time)}</div>
                  <pre className="mt-1 text-xs whitespace-pre-wrap break-words text-zinc-800 font-mono">
                    {entry.line}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

