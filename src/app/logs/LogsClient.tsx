"use client";

import { useState, useCallback } from "react";

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

export default function LogsClient() {
  const now = Date.now();
  const defaultFrom = new Date(now - INTERVAL_MS["6h"]);
  const defaultTo = new Date(now);
  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(defaultFrom));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(defaultTo));
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("liveness-bot");
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [lastQueryUsed, setLastQueryUsed] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  function highlightMatch(text: string, needle: string): React.ReactNode {
    if (!needle.trim()) return text;
    const parts = text.split(needle);
    if (parts.length <= 1) return text;
    return (
      <>
        {parts.map((part, i) => (
          <span key={i}>
            {i > 0 && <mark className="bg-amber-200 text-zinc-900 rounded px-0.5">{needle}</mark>}
            {part}
          </span>
        ))}
      </>
    );
  }

  const applyPreset = useCallback((interval: string) => {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["6h"];
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    setFromStr(toDatetimeLocal(from));
    setToStr(toDatetimeLocal(to));
  }, []);

  async function handleFetch() {
    setError(null);
    setLogs([]);
    setLoading(true);
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
          query: query.trim(),
          target: target.trim() || "liveness-bot",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      setLogs(data.logs ?? []);
      setLastQueryUsed(query.trim());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Grafana logs</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Query Loki via Grafana. Set absolute From/To or use a quick range; target (app label) and optional search filter.
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
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">Target (app label)</label>
          <input
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="liveness-bot"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-sm font-medium text-zinc-700 mb-1">Search query (optional)</label>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='e.g. to pub or |~ "error"'
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={handleFetch}
        disabled={loading}
        className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {loading ? "Loading…" : "Fetch logs"}
      </button>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {logs.length > 0 && (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 overflow-hidden">
          <h2 className="text-sm font-semibold text-zinc-900 px-4 py-2 border-b border-zinc-200 bg-white">
            Logs ({logs.length}) <span className="font-normal text-zinc-500">· times in your local timezone</span>
          </h2>
          <div className="max-h-[60vh] overflow-auto font-mono text-xs">
            {logs.map((entry, i) => (
              <div
                key={i}
                className="flex gap-3 px-4 py-1.5 border-b border-zinc-100 hover:bg-zinc-100/80"
              >
                <span className="shrink-0 text-zinc-500 whitespace-nowrap" title={new Date(entry.time).toISOString()}>
                  {new Date(entry.time).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" })}
                </span>
                <span className="text-zinc-800 break-all">{highlightMatch(entry.line, lastQueryUsed)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && logs.length === 0 && !error && (
        <p className="text-sm text-zinc-500">Click &quot;Fetch logs&quot; to load entries.</p>
      )}
    </div>
  );
}
