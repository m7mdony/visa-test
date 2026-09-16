"use client";

import { useMemo, useRef, useState } from "react";
import AnsiLogLine from "@/components/AnsiLogLine";

type LogEntry = { time: string; line: string };

type PickedEmail = {
  email: string;
  maxUploadTime: string;
  line: string;
};

type EmailResult = {
  email: string;
  maxUploadTime: string;
  logs: LogEntry[];
  chunks: number;
  status: "pending" | "running" | "done" | "error" | "skipped";
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

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString();
}

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900";

export default function MaxUploadClient() {
  const now = Date.now();
  const [maxFromStr, setMaxFromStr] = useState(() => toDatetimeLocal(new Date(now - INTERVAL_MS["24h"])));
  const [maxToStr, setMaxToStr] = useState(() => toDatetimeLocal(new Date(now)));
  const [docsFromStr, setDocsFromStr] = useState(() => toDatetimeLocal(new Date(now - INTERVAL_MS["24h"] * 7)));
  const [docsToStr, setDocsToStr] = useState(() => toDatetimeLocal(new Date(now)));
  const [emailCount, setEmailCount] = useState(5);

  const [emailLoading, setEmailLoading] = useState(false);
  const [docsRunning, setDocsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedEmail[]>([]);
  const [matchedLogs, setMatchedLogs] = useState(0);
  const [results, setResults] = useState<EmailResult[]>([]);
  const [progress, setProgress] = useState("");
  const [openEmail, setOpenEmail] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState("");
  const abortRef = useRef(false);

  function applyMaxPreset(interval: string) {
    const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["24h"];
    const to = new Date();
    setMaxFromStr(toDatetimeLocal(new Date(to.getTime() - ms)));
    setMaxToStr(toDatetimeLocal(to));
  }

  async function searchEmails() {
    setError(null);
    abortRef.current = true;
    setDocsRunning(false);
    setEmailLoading(true);
    setPicked([]);
    setResults([]);
    setProgress("");
    setOpenEmail(null);

    const maxFrom = new Date(maxFromStr).getTime();
    const maxTo = new Date(maxToStr).getTime();
    const x = Math.min(50, Math.max(1, Math.floor(Number(emailCount) || 1)));
    if (!Number.isFinite(maxFrom) || !Number.isFinite(maxTo) || maxFrom >= maxTo) {
      setError("Max upload From must be before To.");
      setEmailLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/max-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "emails", maxFrom, maxTo, emailCount: x }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        emails?: PickedEmail[];
        matchedLogs?: number;
        error?: string;
      };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      const emails = Array.isArray(json.emails) ? json.emails : [];
      setPicked(emails);
      setMatchedLogs(typeof json.matchedLogs === "number" ? json.matchedLogs : 0);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setEmailLoading(false);
    }
  }

  async function runDocsSearch() {
    if (picked.length === 0) {
      setError("Search Max upload first.");
      return;
    }
    const docsFrom = new Date(docsFromStr).getTime();
    const docsTo = new Date(docsToStr).getTime();
    if (!Number.isFinite(docsFrom) || !Number.isFinite(docsTo) || docsFrom >= docsTo) {
      setError("Upload documents From must be before To.");
      return;
    }

    abortRef.current = false;
    setError(null);
    setDocsRunning(true);
    setResults(
      picked.map((p) => ({
        email: p.email,
        maxUploadTime: p.maxUploadTime,
        logs: [],
        chunks: 0,
        status: "pending",
      }))
    );

    try {
      for (let i = 0; i < picked.length; i++) {
        if (abortRef.current) {
          setProgress("Stopped.");
          break;
        }
        const item = picked[i];
        setProgress(`Email ${i + 1}/${picked.length} · ${item.email}`);
        setOpenEmail(item.email);
        setResults((prev) =>
          prev.map((r) => (r.email === item.email ? { ...r, status: "running" } : r))
        );

        try {
          const res = await fetch("/api/max-upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "docs",
              email: item.email,
              logTime: Date.parse(item.maxUploadTime),
              docsFrom,
              docsTo,
            }),
          });
          const json = (await res.json().catch(() => ({}))) as {
            logs?: LogEntry[];
            chunks?: number;
            skipped?: boolean;
            reason?: string;
            error?: string;
          };
          if (!res.ok) {
            setResults((prev) =>
              prev.map((r) =>
                r.email === item.email
                  ? { ...r, status: "error", error: json.error ?? `HTTP ${res.status}` }
                  : r
              )
            );
            continue;
          }
          setResults((prev) =>
            prev.map((r) =>
              r.email === item.email
                ? {
                    ...r,
                    status: json.skipped ? "skipped" : "done",
                    logs: Array.isArray(json.logs) ? json.logs : [],
                    chunks: typeof json.chunks === "number" ? json.chunks : 0,
                    error: json.reason,
                  }
                : r
            )
          );
        } catch (e: unknown) {
          setResults((prev) =>
            prev.map((r) =>
              r.email === item.email
                ? { ...r, status: "error", error: e instanceof Error ? e.message : "Request failed" }
                : r
            )
          );
        }
      }
      if (!abortRef.current) setProgress(`Done · ${picked.length} emails`);
    } finally {
      setDocsRunning(false);
    }
  }

  const openResult = results.find((r) => r.email === openEmail) ?? null;
  const filteredOpenLogs = useMemo(() => {
    if (!openResult) return [];
    const q = logFilter.trim().toLowerCase();
    if (!q) return openResult.logs;
    return openResult.logs.filter((e) => `${e.time} ${e.line}`.toLowerCase().includes(q));
  }, [openResult, logFilter]);

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Max upload</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Pick X emails from <code>Max upload</code> logs, then search each one sequentially for{" "}
          <code>/UploadApplicantDocument] Response:</code> in 24h steps from that log time back to
          your documents From date.
        </p>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-zinc-50/80 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900">1. Max upload search</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">From</label>
            <input type="datetime-local" value={maxFromStr} onChange={(e) => setMaxFromStr(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">To</label>
            <input type="datetime-local" value={maxToStr} onChange={(e) => setMaxToStr(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Emails (x)</label>
            <input
              type="number"
              min={1}
              max={50}
              value={emailCount}
              onChange={(e) => setEmailCount(Number(e.target.value))}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col justify-end">
            <label className="block text-sm font-medium text-zinc-700 mb-1">Quick range</label>
            <div className="flex gap-2 flex-wrap">
              {(["15m", "1h", "6h", "24h"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => applyMaxPreset(v)}
                  className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 bg-white"
                >
                  Last {v}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-zinc-50/80 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900">2. Upload documents search</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">From</label>
            <input type="datetime-local" value={docsFromStr} onChange={(e) => setDocsFromStr(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">To</label>
            <input type="datetime-local" value={docsToStr} onChange={(e) => setDocsToStr(e.target.value)} className={inputClass} />
          </div>
        </div>
        <p className="text-xs text-zinc-500">
          Each email starts at its Max upload log time (capped by this To) and walks back 24h until this From.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void searchEmails()}
          disabled={emailLoading || docsRunning}
          className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {emailLoading ? "Searching..." : "Search Max upload"}
        </button>
        <button
          type="button"
          onClick={() => void runDocsSearch()}
          disabled={emailLoading || docsRunning || picked.length === 0}
          className="inline-flex items-center rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-50"
        >
          {docsRunning ? "Running..." : "Search upload documents"}
        </button>
        {docsRunning && (
          <button
            type="button"
            onClick={() => {
              abortRef.current = true;
            }}
            className="inline-flex items-center rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
          >
            Stop
          </button>
        )}
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
      )}
      {progress && <p className="text-sm text-zinc-600">{progress}</p>}

      <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
        <div className="px-4 py-2 border-b border-zinc-200 bg-zinc-50 text-sm text-zinc-700">
          Emails: <span className="font-medium">{picked.length}</span>
          {matchedLogs > 0 && <span className="text-zinc-500"> · {matchedLogs} Max upload lines</span>}
        </div>
        {picked.length === 0 ? (
          <p className="px-4 py-4 text-sm text-zinc-500">No emails yet. Run Max upload search.</p>
        ) : (
          <div className="divide-y divide-zinc-100">
            {picked.map((item) => {
              const result = results.find((r) => r.email === item.email);
              return (
                <button
                  key={item.email}
                  type="button"
                  className={`w-full text-left px-4 py-3 hover:bg-zinc-50 ${openEmail === item.email ? "bg-zinc-50" : ""}`}
                  onClick={() => setOpenEmail(item.email === openEmail ? null : item.email)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-zinc-900 truncate">{item.email}</span>
                    <span className="text-xs text-zinc-500 shrink-0">
                      {result
                        ? result.status === "running"
                          ? "running"
                          : result.status === "done"
                            ? `${result.logs.length} lines · ${result.chunks} chunks`
                            : result.status
                        : fmtTime(item.maxUploadTime)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-500">Max upload {fmtTime(item.maxUploadTime)}</p>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {openResult && (
        <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
          <div className="px-4 py-2 border-b border-zinc-200 bg-zinc-50 text-sm text-zinc-700">
            {openResult.email} · {openResult.logs.length} stacked lines
            {openResult.error ? ` · ${openResult.error}` : ""}
          </div>
          <div className="px-4 py-3 border-b border-zinc-100">
            <input
              type="search"
              value={logFilter}
              onChange={(e) => setLogFilter(e.target.value)}
              placeholder="Filter logs..."
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            />
          </div>
          <div className="max-h-[55vh] overflow-auto divide-y divide-zinc-100">
            {openResult.status === "running" && openResult.logs.length === 0 ? (
              <p className="px-4 py-4 text-sm text-zinc-500">Searching 24h intervals…</p>
            ) : filteredOpenLogs.length === 0 ? (
              <p className="px-4 py-4 text-sm text-zinc-500">No matching logs.</p>
            ) : (
              filteredOpenLogs.map((entry, idx) => (
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
      )}
    </div>
  );
}
