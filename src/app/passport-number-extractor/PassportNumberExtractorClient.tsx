"use client";

import { useState } from "react";

type ExtractedRow = {
  email: string;
  passportNumber: string | null;
};

type ExtractResponse = {
  emailsFromInput: string[];
  searchedFrom: number;
  searchedTo: number;
  rows: ExtractedRow[];
  errors?: string[];
};

function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString();
}

function toDatetimeLocal(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

export default function PassportNumberExtractorClient() {
  const now = Date.now();
  const [logsText, setLogsText] = useState("");
  const [fromStr, setFromStr] = useState(() => toDatetimeLocal(now - 2 * 60 * 60 * 1000));
  const [toStr, setToStr] = useState(() => toDatetimeLocal(now + 2 * 60 * 60 * 1000));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ExtractResponse | null>(null);

  async function handleExtract() {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch("/api/passport-number-extractor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logsText,
          from: fromStr ? new Date(fromStr).getTime() : undefined,
          to: toStr ? new Date(toStr).getTime() : undefined,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as ExtractResponse & { error?: string };
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

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Passport number extractor</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Paste log lines, extract each <code>email=</code>, then search <code>vfs-global-bot</code> (prod) for
          matching passport numbers.
        </p>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-zinc-700">Logs input</label>
        <textarea
          value={logsText}
          onChange={(e) => setLogsText(e.target.value)}
          placeholder="Paste logs here..."
          rows={12}
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 font-mono placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
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
      </div>

      <button
        type="button"
        onClick={handleExtract}
        disabled={loading || !logsText.trim()}
        className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {loading ? "Extracting..." : "Extract passport numbers"}
      </button>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {data && (
        <div className="space-y-4">
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
            Emails found: <span className="font-medium">{data.emailsFromInput.length}</span>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700">
            Search window: {fmtTime(new Date(data.searchedFrom).toISOString())} -{" "}
            {fmtTime(new Date(data.searchedTo).toISOString())}
          </div>

          {Array.isArray(data.errors) && data.errors.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {data.errors.join(" | ")}
            </div>
          )}

          <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
            <div className="px-4 py-2 border-b border-zinc-200 bg-zinc-50 text-sm text-zinc-700">
              Results: <span className="font-medium">{data.rows.length}</span>
            </div>
            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-zinc-50 border-b border-zinc-200">
                  <tr className="text-left text-zinc-700">
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Passport number</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.email} className="border-b border-zinc-100 align-top">
                      <td className="px-3 py-2 font-mono text-xs text-zinc-800">{row.email}</td>
                      <td className="px-3 py-2 font-mono text-xs text-zinc-900">{row.passportNumber ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
