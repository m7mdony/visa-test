"use client";

import { useMemo, useState } from "react";

type VideoGroup = {
  key: string;
  label: string;
  links: string[];
};

type ResultItem =
  | {
      success: true;
      sessionId: string;
      messageId: string;
      videoUrl: string;
    }
  | {
      success: false;
      sessionId?: string;
      videoUrl: string;
      error: string;
    };

function pickRandomWithoutReplacement<T>(items: T[], n: number): T[] {
  if (n >= items.length) return [...items];

  // Fisher–Yates shuffle partial: shuffle first n elements in-place.
  const copy = [...items];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

export default function TestClient({
  videoGroups,
}: {
  videoGroups: VideoGroup[];
}) {
  const [redisUrl, setRedisUrl] = useState(
    process.env.NEXT_PUBLIC_DEFAULT_REDIS_URL ?? "",
  );
  const [sessionApiUrl, setSessionApiUrl] = useState(
    process.env.NEXT_PUBLIC_DEFAULT_SESSION_API_URL ?? "",
  );
  const [streamSuffix, setStreamSuffix] = useState("prod");
  const [videoUrls, setVideoUrls] = useState<string[]>([
    "https://face-liveness-1758087237.s3.us-east-1.amazonaws.com/face-liveness/374100ab-4324-4fdb-b8be-8e8707ff7153_2026-03-09T08-40-04-510Z.webm",
  ]);

  const hasGroups = videoGroups.length > 0;
  const [videoSourceMode, setVideoSourceMode] = useState<"group" | "manual">(
    hasGroups ? "group" : "manual",
  );
  const [selectedGroupKey, setSelectedGroupKey] = useState<string>(
    hasGroups ? videoGroups[0].key : "",
  );
  const [pickMode, setPickMode] = useState<"random" | "all">("random");
  const [pickN, setPickN] = useState<string>("1");

  const [repetitions, setRepetitions] = useState<string>("1");
  const [timeoutSeconds, setTimeoutSeconds] = useState<string>("");
  const [isFirstVerification, setIsFirstVerification] = useState(false);
  const [randomizeOrder, setRandomizeOrder] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ResultItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const computedStreamKey = useMemo(() => {
    const prefix = process.env.NEXT_PUBLIC_STREAM_KEY_PREFIX ?? "";
    return prefix + (streamSuffix || "");
  }, [streamSuffix]);

  const selectedGroup = useMemo(() => {
    if (!selectedGroupKey) return null;
    return videoGroups.find((g) => g.key === selectedGroupKey) ?? null;
  }, [selectedGroupKey, videoGroups]);

  function updateVideoUrl(index: number, value: string) {
    const trimmed = value.trim();
    // If the user pasted a JSON-like array of URLs, e.g. ["link1","link2"] or ['link1','link2'],
    // parse it and replace the list so each URL gets its own input.
    const listCandidate =
      trimmed.endsWith(";") && trimmed.startsWith("[")
        ? trimmed.slice(0, -1).trim()
        : trimmed;
    if (listCandidate.startsWith("[") && listCandidate.endsWith("]")) {
      try {
        const normalized = listCandidate.replace(/'/g, '"');
        const parsed = JSON.parse(normalized);
        if (Array.isArray(parsed)) {
          const urls = parsed
            .map((u) => (typeof u === "string" ? u.trim() : ""))
            .filter(Boolean);
          if (urls.length > 0) {
            setVideoUrls(urls);
            return;
          }
        }
      } catch {
        // fall back to normal single-input behavior
      }
    }

    setVideoUrls((prev) => {
      const copy = [...prev];
      copy[index] = value;
      return copy;
    });
  }

  function addVideoUrl() {
    setVideoUrls((prev) => [...prev, ""]);
  }

  function removeVideoUrl(index: number) {
    setVideoUrls((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleRun() {
    setError(null);
    setResults([]);
    if (!redisUrl.trim()) {
      setError("Redis URL is required");
      return;
    }
    if (!sessionApiUrl.trim()) {
      setError("Session API URL is required");
      return;
    }
    if (!streamSuffix.trim()) {
      setError("Stream key suffix is required");
      return;
    }

    let filteredUrls: string[] = [];
    if (videoSourceMode === "group") {
      if (!selectedGroup) {
        setError("Select a video group");
        return;
      }

      if (selectedGroup.links.length === 0) {
        setError("Selected video group is empty");
        return;
      }

      if (pickMode === "all") {
        filteredUrls = selectedGroup.links;
      } else {
        const n = Number((pickN || "").trim());
        if (!Number.isFinite(n) || n <= 0) {
          setError("Random N must be greater than 0");
          return;
        }
        if (n > selectedGroup.links.length) {
          setError(
            `Random N (${n}) is greater than group size (${selectedGroup.links.length})`,
          );
          return;
        }
        filteredUrls = pickRandomWithoutReplacement(
          selectedGroup.links,
          n,
        );
      }
    } else {
      filteredUrls = videoUrls.map((u) => u.trim()).filter(Boolean);
      if (filteredUrls.length === 0) {
        setError("At least one video URL is required");
        return;
      }
    }
    const repetitionsNum = Number((repetitions || "").trim());
    if (!Number.isFinite(repetitionsNum) || repetitionsNum <= 0) {
      setError("Repetitions must be greater than 0");
      return;
    }

    setRunning(true);
    try {
      const res = await fetch("/api/run-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redisUrl,
          sessionApiUrl,
          streamSuffix,
          videoUrls: filteredUrls,
          repetitions: repetitionsNum,
          timeoutSeconds: Number((timeoutSeconds || "").trim()) || 0,
          isFirstVerification,
          randomizeOrder,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to run test");
      }
      const data = (await res.json()) as { results: ResultItem[] };
      setResults(data.results || []);
    } catch (err: any) {
      setError(err.message || "Failed to run test");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Redis testing</h1>
        <p className="text-sm text-zinc-600 mt-1 max-w-2xl">
          Configure the Redis stream and video URLs, then push test sessions
          into the stream.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">
              Redis URL
            </label>
            <input
              type="text"
              value={redisUrl}
              onChange={(e) => setRedisUrl(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">
              Session API URL
            </label>
            <input
              type="text"
              value={sessionApiUrl}
              onChange={(e) => setSessionApiUrl(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">
              Stream key suffix
            </label>
            <input
              type="text"
              placeholder="prod"
              value={streamSuffix}
              onChange={(e) => setStreamSuffix(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Prefix from env:{" "}
              <code>{process.env.NEXT_PUBLIC_STREAM_KEY_PREFIX ?? ""}</code>
            </p>
            <p className="mt-0.5 text-xs text-zinc-700">
              Computed stream key: <code>{computedStreamKey}</code>
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <input
                id="first-verification"
                type="checkbox"
                checked={isFirstVerification}
                onChange={(e) => setIsFirstVerification(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
              />
              <label
                htmlFor="first-verification"
                className="text-sm text-zinc-700"
              >
                isFirstVerification
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="randomize-order"
                type="checkbox"
                checked={randomizeOrder}
                onChange={(e) => setRandomizeOrder(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
              />
              <label
                htmlFor="randomize-order"
                className="text-sm text-zinc-700"
              >
                Randomize order
              </label>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">
              Repetitions
            </label>
            <input
              type="number"
              min={1}
              value={repetitions}
              onChange={(e) => setRepetitions(e.target.value)}
              className="w-32 rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">
              Timeout between submits (seconds)
            </label>
            <input
              type="number"
              min={0}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(e.target.value)}
              placeholder="0"
              className="w-40 rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            />
            <p className="mt-1 text-xs text-zinc-500">
              If empty or 0, submits are sent with no delay.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <label className="block text-sm font-medium text-zinc-700">
            Video source
          </label>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="radio"
                name="videoSourceMode"
                checked={videoSourceMode === "group"}
                onChange={() => setVideoSourceMode("group")}
                disabled={!hasGroups}
                className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
              />
              Group
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="radio"
                name="videoSourceMode"
                checked={videoSourceMode === "manual"}
                onChange={() => setVideoSourceMode("manual")}
                className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
              />
              Manual
            </label>
          </div>

          {videoSourceMode === "group" ? (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">
                  Video group
                </label>
                <select
                  value={selectedGroupKey}
                  onChange={(e) => setSelectedGroupKey(e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
                >
                  {videoGroups.map((g) => (
                    <option key={g.key} value={g.key}>
                      {g.label} ({g.links.length})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">
                  Pick
                </label>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-zinc-700">
                    <input
                      type="radio"
                      name="pickMode"
                      checked={pickMode === "random"}
                      onChange={() => setPickMode("random")}
                      className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                    />
                    Random N
                  </label>
                  <label className="flex items-center gap-2 text-sm text-zinc-700">
                    <input
                      type="radio"
                      name="pickMode"
                      checked={pickMode === "all"}
                      onChange={() => setPickMode("all")}
                      className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                    />
                    All
                  </label>
                </div>

                {pickMode === "random" ? (
                  <input
                    type="number"
                    min={1}
                    value={pickN}
                    onChange={(e) => setPickN(e.target.value)}
                    className="mt-2 w-32 rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
                    placeholder="N"
                  />
                ) : (
                  <p className="mt-2 text-xs text-zinc-500">
                    Will submit every link in the selected group.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <label className="block text-sm font-medium text-zinc-700">
                Video URLs
              </label>
              {videoUrls.map((url, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={url}
                    onChange={(e) => updateVideoUrl(index, e.target.value)}
                    className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-xs bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
                    placeholder="https://...webm"
                  />
                  {videoUrls.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeVideoUrl(index)}
                      className="rounded-lg border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={addVideoUrl}
                className="mt-1 rounded-lg border border-dashed border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100"
              >
                Add video URL
              </button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleRun}
        disabled={running}
        className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {running ? "Running..." : "Run test"}
      </button>

      {results.length > 0 && (
        <div className="mt-4 rounded-2xl border border-zinc-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-zinc-900 mb-2">
            Results ({results.length})
          </h2>
          <div className="max-h-80 overflow-auto space-y-2 text-xs">
            {results.map((r, idx) => (
              <div
                key={idx}
                className={`rounded-lg border px-3 py-2 ${
                  r.success
                    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                    : "border-red-200 bg-red-50 text-red-900"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium">
                    {r.success ? "Success" : "Failed"}
                  </span>
                  <span className="text-[10px] text-zinc-600">
                    Video: {r.videoUrl.split("/").pop()}
                  </span>
                </div>
                {r.success ? (
                  <p>
                    Session: <code>{r.sessionId}</code> | Message:{" "}
                    <code>{r.messageId}</code>
                  </p>
                ) : (
                  <p>
                    Error: {r.error}
                    {r.sessionId ? (
                      <>
                        {" "}
                        | Session: <code>{r.sessionId}</code>
                      </>
                    ) : null}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

