"use client";

import { useState } from "react";

export default function GenerateClient() {
  const [baseUrl, setBaseUrl] = useState(
    "https://face-verification-app.getlawhat.com",
  );
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleGenerate() {
    setError(null);
    setCopied(false);
    setGeneratedUrl(null);

    const trimmed = baseUrl.trim();

    const normalized =
      trimmed && trimmed.endsWith("/") && trimmed.length > 1
        ? trimmed.replace(/\/+$/, "")
        : trimmed;

    setLoading(true);
    try {
      const res = await fetch("/api/generate-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: normalized || "" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to generate link");
      }
      const data = await res.json();
      setGeneratedUrl(data.fullUrl);
    } catch (err: any) {
      setError(err.message || "Failed to generate link");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!generatedUrl) return;
    try {
      await navigator.clipboard.writeText(generatedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">
          Generate liveness link
        </h1>
        <p className="text-sm text-zinc-600 mt-1 max-w-2xl">
          Calls the liveness session API and replaces the localhost base URL
          with the value you specify here.
        </p>
      </div>

      <div className="space-y-4 max-w-2xl">
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">
            Base URL to replace <code>http://localhost:3003</code>
          </label>
          <input
            type="text"
            placeholder="https://face-verification-app.getlawhat.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={handleGenerate}
          disabled={loading}
          className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? "Generating..." : "Generate link"}
        </button>

        {generatedUrl && (
          <div className="mt-4 space-y-2">
            <label className="block text-sm font-medium text-zinc-700">
              Generated URL
            </label>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={generatedUrl}
                className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-xs text-zinc-800 bg-zinc-50"
              />
              <button
                type="button"
                onClick={handleCopy}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

