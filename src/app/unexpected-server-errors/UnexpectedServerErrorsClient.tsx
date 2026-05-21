"use client";

import { useEffect, useMemo, useState } from "react";

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

function countStartLogs(entries: LogEntry[]): number {
  let count = 0;
  for (const e of entries) {
    if (/\/start\b/i.test(e.line)) count += 1;
  }
  return count;
}

function countStartResponseTookLogs(entries: LogEntry[]): number {
  let count = 0;
  for (const e of entries) {
    if (/\/start\]\s*Response:\s*,\s*took/i.test(e.line)) count += 1;
  }
  return count;
}

function trimFromIdentityTokenReceived(entries: LogEntry[], sourceTimeIso: string): LogEntry[] {
  if (entries.length === 0) return [];
  const sourceMs = Date.parse(sourceTimeIso);
  const tokenIndexes: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (/Identity verification token received/i.test(entries[i].line)) {
      tokenIndexes.push(i);
    }
  }
  if (tokenIndexes.length === 0) return [];

  let startIdx = tokenIndexes[0];
  if (Number.isFinite(sourceMs)) {
    for (const idx of tokenIndexes) {
      const t = Date.parse(entries[idx].time);
      if (!Number.isFinite(t)) continue;
      if (t <= sourceMs) startIdx = idx;
      else break;
    }
  }
  return entries.slice(startIdx);
}

export default function UnexpectedServerErrorsClient() {
  const now = Date.now();
  const defaultFrom = new Date(now - INTERVAL_MS["24h"]);
  const defaultTo = new Date(now);

  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(defaultFrom));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(defaultTo));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [startCountByResultKey, setStartCountByResultKey] = useState<Record<string, number>>({});
  const [startResponseTookCountByResultKey, setStartResponseTookCountByResultKey] = useState<
    Record<string, number>
  >({});
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [selected, setSelected] = useState<{
    source: LogEntry;
    email: string;
    logs: LogEntry[];
  } | null>(null);
  const [popupLoading, setPopupLoading] = useState(false);
  const [popupError, setPopupError] = useState<string | null>(null);
  const [popupSearch, setPopupSearch] = useState("");

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
    setStatsError(null);
    setLoading(true);
    setStatsLoading(false);
    setLogs([]);
    setStartCountByResultKey({});
    setStartResponseTookCountByResultKey({});
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
          query: "UnexpectedServerError",
          additionalFilter: "3/3",
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        logs?: LogEntry[];
        error?: string;
      };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        setLoading(false);
        return;
      }
      const resultLogs = Array.isArray(json.logs) ? json.logs : [];
      setLogs(resultLogs);

      // Build default page stats: how many /start lines per result-session.
      setStatsLoading(true);
      const startCounts: Record<string, number> = {};
      const startResponseTookCounts: Record<string, number> = {};
      for (let i = 0; i < resultLogs.length; i++) {
        const entry = resultLogs[i];
        const key = `${entry.time}-${i}`;
        const email = extractEmail(entry.line);
        if (!email) {
          startCounts[key] = 0;
          startResponseTookCounts[key] = 0;
          continue;
        }
        try {
          const perEmailRes = await fetch("/api/grafana-logs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from: fromMs,
              to: toMs,
              target: "vfs-global-bot",
              query: email,
            }),
          });
          const perEmailJson = (await perEmailRes.json().catch(() => ({}))) as {
            logs?: LogEntry[];
          };
          const allEmailLogs = Array.isArray(perEmailJson.logs) ? perEmailJson.logs : [];
          const trimmed = trimFromIdentityTokenReceived(allEmailLogs, entry.time);
          startCounts[key] = countStartLogs(trimmed);
          startResponseTookCounts[key] = countStartResponseTookLogs(trimmed);
        } catch {
          startCounts[key] = 0;
          startResponseTookCounts[key] = 0;
        }
      }
      setStartCountByResultKey(startCounts);
      setStartResponseTookCountByResultKey(startResponseTookCounts);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
      setStatsLoading(false);
    }
  }

  async function openEmailLogs(entry: LogEntry) {
    setPopupError(null);
    setPopupSearch("");
    const email = extractEmail(entry.line);
    if (!email) {
      setPopupError("No email found in this log line.");
      return;
    }
    setSelected({ source: entry, email, logs: [] });
    setPopupLoading(true);
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
        setPopupError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      const allEmailLogs = Array.isArray(json.logs) ? json.logs : [];
      const trimmedLogs = trimFromIdentityTokenReceived(allEmailLogs, entry.time);
      if (trimmedLogs.length === 0) {
        setPopupError('No "Identity verification token received" line found for this email in range.');
      }
      setSelected({ source: entry, email, logs: trimmedLogs });
    } catch (e: unknown) {
      setPopupError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setPopupLoading(false);
    }
  }

  const filteredPopupLogs = useMemo(() => {
    if (!selected) return [];
    const q = popupSearch.trim().toLowerCase();
    if (!q) return selected.logs;
    return selected.logs.filter((e) => `${e.time} ${e.line}`.toLowerCase().includes(q));
  }, [selected, popupSearch]);

  const startsDistribution = useMemo(() => {
    const dist = new Map<number, number>();
    for (let i = 0; i < logs.length; i++) {
      const k = `${logs[i].time}-${i}`;
      const c = startCountByResultKey[k];
      if (!Number.isFinite(c)) continue;
      dist.set(c, (dist.get(c) ?? 0) + 1);
    }
    return [...dist.entries()]
      .map(([startCount, sessions]) => ({ startCount, sessions }))
      .sort((a, b) => a.startCount - b.startCount);
  }, [logs, startCountByResultKey]);

  const startResponseTookDistribution = useMemo(() => {
    const dist = new Map<number, number>();
    for (let i = 0; i < logs.length; i++) {
      const k = `${logs[i].time}-${i}`;
      const c = startResponseTookCountByResultKey[k];
      if (!Number.isFinite(c)) continue;
      dist.set(c, (dist.get(c) ?? 0) + 1);
    }
    return [...dist.entries()]
      .map(([count, sessions]) => ({ count, sessions }))
      .sort((a, b) => a.count - b.count);
  }, [logs, startResponseTookCountByResultKey]);

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">UnexpectedServerError</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Search <code>vfs-global-bot</code> for <code>UnexpectedServerError</code>, then click a
          row to open all logs for that row&apos;s email.
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

      <button
        type="button"
        onClick={handleSearch}
        disabled={loading}
        className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {loading ? "Searching..." : "Search UnexpectedServerError"}
      </button>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </p>
      )}
      {popupError && !selected && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {popupError}
        </p>
      )}
      {statsError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {statsError}
        </p>
      )}

      <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
        <div className="px-4 py-2 border-b border-zinc-200 bg-zinc-50 text-sm font-medium text-zinc-700">
          /start stats per session
        </div>
        <div className="px-4 py-3">
          {statsLoading ? (
            <p className="text-sm text-zinc-500">Computing /start stats...</p>
          ) : startsDistribution.length === 0 ? (
            <p className="text-sm text-zinc-500">No stats yet. Run search first.</p>
          ) : (
            <div className="space-y-1.5 text-sm">
              {startsDistribution.map((row) => (
                <p key={row.startCount} className="text-zinc-700">
                  <span className="font-medium tabular-nums">{row.sessions}</span> sessions had{" "}
                  <span className="font-medium tabular-nums">{row.startCount}</span> /start
                </p>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
        <div className="px-4 py-2 border-b border-zinc-200 bg-zinc-50 text-sm font-medium text-zinc-700">
          /start] Response: ... took stats per session
        </div>
        <div className="px-4 py-3">
          {statsLoading ? (
            <p className="text-sm text-zinc-500">Computing response+took stats...</p>
          ) : startResponseTookDistribution.length === 0 ? (
            <p className="text-sm text-zinc-500">No stats yet. Run search first.</p>
          ) : (
            <div className="space-y-1.5 text-sm">
              {startResponseTookDistribution.map((row) => (
                <p key={row.count} className="text-zinc-700">
                  <span className="font-medium tabular-nums">{row.sessions}</span> sessions had{" "}
                  <span className="font-medium tabular-nums">{row.count}</span>{" "}
                  <code>/start] Response: ... took</code>
                </p>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
        <div className="px-4 py-2 border-b border-zinc-200 bg-zinc-50 text-sm text-zinc-700">
          Results: <span className="font-medium">{logs.length}</span>
        </div>
        <div className="max-h-[65vh] overflow-auto">
          {logs.length === 0 ? (
            <p className="px-4 py-4 text-sm text-zinc-500">
              No UnexpectedServerError logs found in this time range.
            </p>
          ) : (
            <div className="divide-y divide-zinc-100">
              {logs.map((entry, idx) => (
                <button
                  key={`${entry.time}-${idx}`}
                  type="button"
                  className="w-full text-left px-4 py-3 hover:bg-zinc-50"
                  onClick={() => void openEmailLogs(entry)}
                >
                  <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
                    <span>{fmtTime(entry.time)}</span>
                    <div className="text-zinc-600 text-right">
                      <div>
                        /start:{" "}
                        <span className="font-medium tabular-nums">
                          {startCountByResultKey[`${entry.time}-${idx}`] ?? "-"}
                        </span>
                      </div>
                      <div>
                        /start] Response+took:{" "}
                        <span className="font-medium tabular-nums">
                          {startResponseTookCountByResultKey[`${entry.time}-${idx}`] ?? "-"}
                        </span>
                      </div>
                    </div>
                  </div>
                  <pre className="mt-1 text-xs whitespace-pre-wrap break-words text-zinc-800 font-mono">
                    {entry.line}
                  </pre>
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
            className="w-full max-w-4xl max-h-[85vh] rounded-xl border border-zinc-200 bg-white shadow-lg overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900">Email logs</h2>
                <p className="text-xs text-zinc-600">
                  {selected.email} · source at {fmtTime(selected.source.time)}
                </p>
                <p className="text-xs text-zinc-600">
                  /start in this popup:{" "}
                  <span className="font-medium tabular-nums">{countStartLogs(selected.logs)}</span>
                </p>
                <p className="text-xs text-zinc-600">
                  /start] Response: ... took in this popup:{" "}
                  <span className="font-medium tabular-nums">
                    {countStartResponseTookLogs(selected.logs)}
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-lg px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100"
              >
                Close
              </button>
            </div>

            <div className="px-4 py-3 border-b border-zinc-100">
              <input
                type="search"
                value={popupSearch}
                onChange={(e) => setPopupSearch(e.target.value)}
                placeholder="Search inside popup logs..."
                className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
              />
            </div>

            {popupError && (
              <p className="m-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                {popupError}
              </p>
            )}

            <div className="px-4 py-2 text-xs text-zinc-500 border-b border-zinc-100 bg-zinc-50">
              {popupLoading
                ? "Loading logs..."
                : `Showing ${filteredPopupLogs.length} of ${selected.logs.length} lines`}
            </div>

            <div className="max-h-[55vh] overflow-auto divide-y divide-zinc-100">
              {!popupLoading && filteredPopupLogs.length === 0 ? (
                <p className="px-4 py-4 text-sm text-zinc-500">No matching logs.</p>
              ) : (
                filteredPopupLogs.map((entry, idx) => (
                  <div key={`${entry.time}-${idx}`} className="px-4 py-3">
                    <div className="text-xs text-zinc-500">{fmtTime(entry.time)}</div>
                    <pre className="mt-1 text-xs whitespace-pre-wrap break-words text-zinc-800 font-mono">
                      {entry.line}
                    </pre>
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

