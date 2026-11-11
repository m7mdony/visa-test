"use client";

import { useState } from "react";
import { parseVfsPassportFromLog, type ParsedVfsPassportFromLog } from "@/lib/vfsPassportFromLog";

export default function PassportFromLogClient() {
  const [logsText, setLogsText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedVfsPassportFromLog | null>(null);

  function handleShow() {
    setError(null);
    setParsed(null);
    try {
      setParsed(parseVfsPassportFromLog(logsText));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleClear() {
    setLogsText("");
    setError(null);
    setParsed(null);
  }

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Passport from VFS log</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Paste full Grafana / bot log blocks (many lines OK). Finds{" "}
          <code className="text-xs">UploadApplicantDocument</code>{" "}
          <code className="text-xs">Request: {"{…fileBytes…}"}</code> (or legacy{" "}
          <code className="text-xs">Request body:</code>) and shows the uploaded passport image.
        </p>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-zinc-700">Log line or JSON</label>
        <textarea
          value={logsText}
          onChange={(e) => setLogsText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") handleShow();
          }}
          placeholder="Paste job logs (multi-line) — includes UploadApplicantDocument Request with fileBytes…"
          rows={12}
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 font-mono placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleShow}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          Show passport
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Clear
        </button>
        <span className="self-center text-xs text-zinc-500">Ctrl+Enter to preview</span>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {parsed ? (
        <div className="space-y-4">
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr] rounded-lg border border-zinc-200 bg-zinc-50 p-4">
            <dt className="text-zinc-500">matched from</dt>
            <dd>{parsed.matchedFrom}</dd>
            <dt className="text-zinc-500">passportNumber (log tail)</dt>
            <dd className="font-mono text-zinc-900 break-all">{parsed.passportNumberFromTail ?? "—"}</dd>
            <dt className="text-zinc-500">loginUser</dt>
            <dd className="break-all">{parsed.body.loginUser ?? "—"}</dd>
            <dt className="text-zinc-500">missionCode</dt>
            <dd>{parsed.body.missionCode ?? "—"}</dd>
            <dt className="text-zinc-500">countryCode</dt>
            <dd>{parsed.body.countryCode ?? "—"}</dd>
            <dt className="text-zinc-500">centerCode</dt>
            <dd>{parsed.body.centerCode ?? "—"}</dd>
            <dt className="text-zinc-500">visaCategoryCode</dt>
            <dd>{parsed.body.visaCategoryCode ?? "—"}</dd>
            <dt className="text-zinc-500">image field</dt>
            <dd className="font-mono">{parsed.imageField}</dd>
            <dt className="text-zinc-500">decoded size (approx)</dt>
            <dd>{parsed.decodedSizeBytes.toLocaleString()} bytes</dd>
          </dl>

          <div className="rounded-lg border border-zinc-200 p-4">
            <p className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Preview — {parsed.imageField}</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={parsed.imageDataUrl}
              alt="Passport from log fileBytes"
              className="mx-auto max-h-[70vh] w-auto max-w-full rounded border border-zinc-200 bg-black object-contain"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
