"use client";

import { useEffect, useMemo, useState } from "react";
import AnsiLogLine from "@/components/AnsiLogLine";

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

function extractEmail(line: string): string | null {
  const m = line.match(/\bemail=([^\s]+)/i);
  return m?.[1]?.trim().toLowerCase() ?? null;
}

function extractRoute(line: string): { from: string; to: string } | null {
  const m = line.match(/\[From:\s*(\S+)\s+To:\s*(\S+)/i);
  if (!m) return null;
  return { from: m[1].replace(/,$/, ""), to: m[2].replace(/,$/, "") };
}

function buildCountryFilters(fromCountry: string, toCountry: string): string[] {
  const filters: string[] = [];
  const from = fromCountry.trim().toLowerCase();
  const to = toCountry.trim().toLowerCase();
  if (from) filters.push(`fromCountry=${from}`);
  if (to) filters.push(`toCountry=${to}`);
  return filters;
}

export default function BookingJobsClient() {
  const now = Date.now();
  const defaultFrom = new Date(now - INTERVAL_MS["24h"]);
  const defaultTo = new Date(now);

  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(defaultFrom));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(defaultTo));
  const [fromCountry, setFromCountry] = useState("");
  const [toCountry, setToCountry] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const [selected, setSelected] = useState<{
    source: LogEntry;
    email: string;
    logs: LogEntry[];
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailSearch, setDetailSearch] = useState("");

  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected]);

  function applyPreset(interval: string) {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["24h"];
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    setFromStr(toDatetimeLocal(from));
    setToStr(toDatetimeLocal(to));
  }

  async function handleSearch() {
    setError(null);
    setLoading(true);
    setLogs([]);
    setSelected(null);

    const fromMs = new Date(fromStr).getTime();
    const toMs = new Date(toStr).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      setError("From must be before To (use valid date-time).");
      setLoading(false);
      return;
    }

    const countryFilters = buildCountryFilters(fromCountry, toCountry);

    try {
      const res = await fetch("/api/grafana-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromMs,
          to: toMs,
          target: "vfs-global-bot",
          query: "Starting booking job",
          ...(countryFilters.length > 0 && { additionalFilters: countryFilters }),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        logs?: LogEntry[];
        error?: string;
      };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setLogs(Array.isArray(json.logs) ? json.logs : []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  async function openEmailLogs(entry: LogEntry) {
    setDetailError(null);
    setDetailSearch("");
    const email = extractEmail(entry.line);
    if (!email) {
      setDetailError("No email found in this log line.");
      return;
    }
    setSelected({ source: entry, email, logs: [] });
    setDetailLoading(true);

    const fromMs = new Date(fromStr).getTime();
    const toMs = new Date(toStr).getTime();
    try {
      const res = await fetch("/api/grafana-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromMs,
          to: toMs,
          target: "vfs-global-bot",
          query: email,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        logs?: LogEntry[];
        error?: string;
      };
      if (!res.ok) {
        setDetailError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      const emailLogs = Array.isArray(json.logs) ? json.logs : [];
      setSelected({ source: entry, email, logs: emailLogs });
    } catch (e: unknown) {
      setDetailError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setDetailLoading(false);
    }
  }

  const filteredDetailLogs = useMemo(() => {
    if (!selected) return [];
    const q = detailSearch.trim().toLowerCase();
    if (!q) return selected.logs;
    return selected.logs.filter((e) => `${e.time} ${e.line}`.toLowerCase().includes(q));
  }, [selected, detailSearch]);

  const entriesWithMeta = useMemo(
    () =>
      logs.map((entry, idx) => ({
        entry,
        idx,
        email: extractEmail(entry.line),
        route: extractRoute(entry.line),
      })),
    [logs]
  );

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Booking jobs</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Search <code>vfs-global-bot</code> for <code>Starting booking job</code>, optionally
          filter by route, then click an email to read all logs for that applicant in the range.
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
          <label className="block text-sm font-medium text-zinc-700 mb-1">From country (optional)</label>
          <input
            type="text"
            value={fromCountry}
            onChange={(e) => setFromCountry(e.target.value)}
            placeholder="e.g. egy"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">To country (optional)</label>
          <input
            type="text"
            value={toCountry}
            onChange={(e) => setToCountry(e.target.value)}
            placeholder="e.g. grc"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
          <p className="mt-1 text-xs text-zinc-500">Leave empty for all routes.</p>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSearch}
        disabled={loading}
        className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {loading ? "Searching..." : "Search booking jobs"}
      </button>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
        <div className="px-4 py-2 border-b border-zinc-200 bg-zinc-50 text-sm text-zinc-700">
          Results: <span className="font-medium">{logs.length}</span>
          {(fromCountry.trim() || toCountry.trim()) && (
            <span className="text-zinc-500">
              {" "}
              · filter{" "}
              {fromCountry.trim() && (
                <code className="text-zinc-600">fromCountry={fromCountry.trim().toLowerCase()}</code>
              )}
              {fromCountry.trim() && toCountry.trim() && " + "}
              {toCountry.trim() && (
                <code className="text-zinc-600">toCountry={toCountry.trim().toLowerCase()}</code>
              )}
            </span>
          )}
        </div>
        <div className="max-h-[65vh] overflow-auto">
          {logs.length === 0 ? (
            <p className="px-4 py-4 text-sm text-zinc-500">
              No booking job logs in this range. Adjust dates or country filters and search again.
            </p>
          ) : (
            <div className="divide-y divide-zinc-100">
              {entriesWithMeta.map(({ entry, idx, email, route }) => (
                <button
                  key={`${entry.time}-${idx}`}
                  type="button"
                  className="w-full text-left px-4 py-3 hover:bg-zinc-50 disabled:opacity-50"
                  disabled={!email}
                  onClick={() => void openEmailLogs(entry)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-zinc-900 truncate">
                      {email ?? "(no email in line)"}
                    </span>
                    <span className="text-xs text-zinc-500 shrink-0">{fmtTime(entry.time)}</span>
                  </div>
                  {route && (
                    <p className="mt-0.5 text-xs text-zinc-600">
                      {route.from} → {route.to}
                    </p>
                  )}
                  <AnsiLogLine
                    text={entry.line}
                    className="mt-1.5 text-xs whitespace-pre-wrap break-words text-zinc-500 font-mono line-clamp-2"
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40"
          role="dialog"
          aria-modal="true"
          onClick={() => setSelected(null)}
        >
          <div
            className="w-full max-w-4xl max-h-[85vh] rounded-xl border border-zinc-200 bg-white shadow-lg overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2 border-b border-zinc-200 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900">{selected.email}</h2>
                <p className="text-xs text-zinc-600 mt-0.5">
                  All vfs-global-bot logs in range · clicked job at {fmtTime(selected.source.time)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-lg px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 shrink-0"
              >
                Close
              </button>
            </div>

            <div className="px-4 py-3 border-b border-zinc-100">
              <input
                type="search"
                value={detailSearch}
                onChange={(e) => setDetailSearch(e.target.value)}
                placeholder="Search inside logs..."
                className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
              />
            </div>

            {detailError && (
              <p className="m-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                {detailError}
              </p>
            )}

            <div className="px-4 py-2 text-xs text-zinc-500 border-b border-zinc-100 bg-zinc-50">
              {detailLoading
                ? "Loading logs..."
                : `Showing ${filteredDetailLogs.length} of ${selected.logs.length} lines`}
            </div>

            <div className="flex-1 min-h-0 overflow-auto divide-y divide-zinc-100">
              {!detailLoading && filteredDetailLogs.length === 0 ? (
                <p className="px-4 py-4 text-sm text-zinc-500">No matching logs.</p>
              ) : (
                filteredDetailLogs.map((entry, idx) => (
                  <div key={`${entry.time}-${idx}`} className="px-4 py-3">
                    <div className="text-xs text-zinc-500">{fmtTime(entry.time)}</div>
                    <AnsiLogLine
                      text={entry.line}
                      className="mt-1 text-xs whitespace-pre-wrap break-words text-zinc-800 font-mono"
                    />
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
