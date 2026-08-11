"use client";

import { useMemo, useState } from "react";
import AnsiLogLine from "@/components/AnsiLogLine";
import type { EmailErrorGroup, ErrorTypeCount, ParsedBotLog } from "@/lib/botNotableErrors";

type Tab = "errors" | "emails" | "logs";

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

export default function BotNotableErrorsClient() {
  const now = Date.now();
  const defaultFrom = new Date(now - INTERVAL_MS["6h"]);
  const defaultTo = new Date(now);

  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(defaultFrom));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(defaultTo));
  const [fromCountry, setFromCountry] = useState("");
  const [toCountry, setToCountry] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("errors");
  const [search, setSearch] = useState("");
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const [expandedEmail, setExpandedEmail] = useState<string | null>(null);

  const [summary, setSummary] = useState<{
    totalLogs: number;
    uniqueErrorTypes: number;
    uniqueEmails: number;
    logsWithoutEmail: number;
  } | null>(null);
  const [errorTypeCounts, setErrorTypeCounts] = useState<ErrorTypeCount[]>([]);
  const [byEmail, setByEmail] = useState<EmailErrorGroup[]>([]);
  const [parsed, setParsed] = useState<ParsedBotLog[]>([]);
  const [lokiExpr, setLokiExpr] = useState<string | null>(null);

  function applyPreset(interval: string) {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["6h"];
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    setFromStr(toDatetimeLocal(from));
    setToStr(toDatetimeLocal(to));
  }

  async function handleSearch() {
    setError(null);
    setLoading(true);
    setSummary(null);
    setErrorTypeCounts([]);
    setByEmail([]);
    setParsed([]);
    setExpandedError(null);
    setExpandedEmail(null);

    const fromMs = new Date(fromStr).getTime();
    const toMs = new Date(toStr).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      setError("From must be before To (use valid date-time).");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/bot-notable-errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromMs,
          to: toMs,
          ...(fromCountry.trim() && { fromCountry: fromCountry.trim() }),
          ...(toCountry.trim() && { toCountry: toCountry.trim() }),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        summary?: typeof summary;
        errorTypeCounts?: ErrorTypeCount[];
        byEmail?: EmailErrorGroup[];
        parsed?: ParsedBotLog[];
        lokiExpr?: string;
      };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setSummary(json.summary ?? null);
      setErrorTypeCounts(Array.isArray(json.errorTypeCounts) ? json.errorTypeCounts : []);
      setByEmail(Array.isArray(json.byEmail) ? json.byEmail : []);
      setParsed(Array.isArray(json.parsed) ? json.parsed : []);
      setLokiExpr(typeof json.lokiExpr === "string" ? json.lokiExpr : null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  const q = search.trim().toLowerCase();

  const filteredErrors = useMemo(() => {
    if (!q) return errorTypeCounts;
    return errorTypeCounts.filter(
      (e) => e.errorKey.toLowerCase().includes(q) || e.sampleLine.toLowerCase().includes(q)
    );
  }, [errorTypeCounts, q]);

  const filteredEmails = useMemo(() => {
    if (!q) return byEmail;
    return byEmail.filter(
      (g) =>
        g.email.includes(q) ||
        g.errorTypes.some((t) => t.errorKey.toLowerCase().includes(q)) ||
        g.logs.some((l) => l.line.toLowerCase().includes(q))
    );
  }, [byEmail, q]);

  const filteredLogs = useMemo(() => {
    if (!q) return parsed;
    return parsed.filter(
      (p) =>
        p.line.toLowerCase().includes(q) ||
        p.errorKey.toLowerCase().includes(q) ||
        (p.email?.includes(q) ?? false)
    );
  }, [parsed, q]);

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Bot notable errors</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Notable <code>vfs-global-bot</code> errors (noise filtered out). Analysis groups
          heterogeneous log lines by normalized error message and email.
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
            placeholder="e.g. gnb"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">To country (optional)</label>
          <input
            type="text"
            value={toCountry}
            onChange={(e) => setToCountry(e.target.value)}
            placeholder="e.g. prt"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
          <p className="mt-1 text-xs text-zinc-500">Leave empty for all routes.</p>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void handleSearch()}
        disabled={loading}
        className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {loading ? "Searching…" : "Search notable errors"}
      </button>

      {lokiExpr && (
        <p className="text-xs text-zinc-500 font-mono break-all bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2">
          {lokiExpr}
        </p>
      )}

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {summary && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: "Total logs", value: summary.totalLogs },
            { label: "Unique error types", value: summary.uniqueErrorTypes },
            { label: "Unique emails", value: summary.uniqueEmails },
            { label: "Without email", value: summary.logsWithoutEmail },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3">
              <p className="text-xs text-zinc-500">{s.label}</p>
              <p className="text-xl font-semibold tabular-nums text-zinc-900">{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {summary && (
        <>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex gap-1 rounded-lg border border-zinc-200 p-1 bg-zinc-50">
              {(
                [
                  ["errors", "By error type"],
                  ["emails", "By email"],
                  ["logs", "All logs"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={`rounded-md px-3 py-1.5 text-sm ${
                    tab === id ? "bg-white shadow-sm text-zinc-900 font-medium" : "text-zinc-600 hover:text-zinc-900"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter results…"
              className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900"
            />
          </div>

          {tab === "errors" && (
            <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
              <div className="px-4 py-2 border-b border-zinc-200 bg-zinc-50 text-sm text-zinc-700">
                Error types: <span className="font-medium">{filteredErrors.length}</span>
              </div>
              <div className="max-h-[65vh] overflow-auto divide-y divide-zinc-100">
                {filteredErrors.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-zinc-500">No matching error types.</p>
                ) : (
                  filteredErrors.map((row) => (
                    <div key={row.errorKey} className="px-4 py-3">
                      <button
                        type="button"
                        className="w-full text-left"
                        onClick={() =>
                          setExpandedError((cur) => (cur === row.errorKey ? null : row.errorKey))
                        }
                      >
                        <div className="flex items-start justify-between gap-3">
                          <p className="text-sm font-medium text-zinc-900 break-words">{row.errorKey}</p>
                          <span className="shrink-0 rounded-full bg-zinc-900 text-white text-xs font-medium tabular-nums px-2.5 py-0.5">
                            {row.count}
                          </span>
                        </div>
                      </button>
                      {expandedError === row.errorKey && (
                        <div className="mt-2 rounded-lg bg-zinc-50 border border-zinc-100 px-3 py-2">
                          <p className="text-xs text-zinc-500 mb-1">Sample log</p>
                          <AnsiLogLine
                            text={row.sampleLine}
                            className="text-xs whitespace-pre-wrap break-words text-zinc-800 font-mono"
                          />
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {tab === "emails" && (
            <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
              <div className="px-4 py-2 border-b border-zinc-200 bg-zinc-50 text-sm text-zinc-700">
                Emails: <span className="font-medium">{filteredEmails.length}</span>
              </div>
              <div className="max-h-[65vh] overflow-auto divide-y divide-zinc-100">
                {filteredEmails.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-zinc-500">No matching emails.</p>
                ) : (
                  filteredEmails.map((group) => (
                    <div key={group.email} className="px-4 py-3">
                      <button
                        type="button"
                        className="w-full text-left"
                        onClick={() =>
                          setExpandedEmail((cur) => (cur === group.email ? null : group.email))
                        }
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-zinc-900 break-all">{group.email}</p>
                            <p className="text-xs text-zinc-500 mt-0.5">
                              {group.errorTypes.length} error type{group.errorTypes.length === 1 ? "" : "s"}
                            </p>
                          </div>
                          <span className="shrink-0 rounded-full bg-zinc-900 text-white text-xs font-medium tabular-nums px-2.5 py-0.5">
                            {group.count}
                          </span>
                        </div>
                      </button>
                      {expandedEmail === group.email && (
                        <div className="mt-3 space-y-3">
                          <div className="rounded-lg bg-zinc-50 border border-zinc-100 px-3 py-2 space-y-1">
                            {group.errorTypes.map((t) => (
                              <p key={t.errorKey} className="text-xs text-zinc-700">
                                <span className="font-medium tabular-nums">{t.count}</span>× {t.errorKey}
                              </p>
                            ))}
                          </div>
                          <div className="space-y-2 max-h-80 overflow-auto">
                            {group.logs.map((entry, idx) => (
                              <div key={`${entry.time}-${idx}`} className="border-l-2 border-zinc-200 pl-3">
                                <p className="text-xs text-zinc-500">{fmtTime(entry.time)}</p>
                                <AnsiLogLine
                                  text={entry.line}
                                  className="mt-0.5 text-xs whitespace-pre-wrap break-words text-zinc-800 font-mono"
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {tab === "logs" && (
            <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
              <div className="px-4 py-2 border-b border-zinc-200 bg-zinc-50 text-sm text-zinc-700">
                Logs: <span className="font-medium">{filteredLogs.length}</span>
              </div>
              <div className="max-h-[65vh] overflow-auto divide-y divide-zinc-100">
                {filteredLogs.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-zinc-500">No matching logs.</p>
                ) : (
                  filteredLogs.map((entry, idx) => (
                    <div key={`${entry.time}-${idx}`} className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                        <span>{fmtTime(entry.time)}</span>
                        {entry.email && <span className="text-zinc-600">{entry.email}</span>}
                        {entry.fromCountry && entry.toCountry && (
                          <span>
                            {entry.fromCountry}→{entry.toCountry}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-zinc-500 mt-1 break-words">{entry.errorKey}</p>
                      <AnsiLogLine
                        text={entry.line}
                        className="mt-1 text-xs whitespace-pre-wrap break-words text-zinc-800 font-mono"
                      />
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
