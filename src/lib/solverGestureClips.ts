import type { GestureClipEntry } from "@/lib/visaflowDashboardPassports";

export type SolverGestureClipMatch = {
  feedbackClip: string;
  sourceClip: string;
  rotateDeg: number;
  synthesized: boolean;
  clipUrl: string | null;
};

function gestureKey(g: string): string {
  return g.trim();
}

function findClipByGestureName(
  clips: GestureClipEntry[],
  name: string,
): GestureClipEntry | undefined {
  const want = gestureKey(name);
  if (!want) return undefined;
  const exact = clips.find((c) => c.gesture === want);
  if (exact) return exact;
  const lower = want.toLowerCase();
  return clips.find((c) => c.gesture.toLowerCase() === lower);
}

/** One dashboard clip per Azure feedback gesture id (no up/down tilt synthesis). */
export function resolveSolverGestureSource(feedbackClip: string): {
  feedbackClip: string;
  sourceClip: string;
  rotateDeg: number;
  synthesized: boolean;
} {
  const feedback = gestureKey(feedbackClip);
  return {
    feedbackClip: feedback,
    sourceClip: feedback,
    rotateDeg: 0,
    synthesized: false,
  };
}

export function findSolverGestureClip(
  clips: GestureClipEntry[] | undefined,
  feedbackClip: string,
): SolverGestureClipMatch {
  const resolved = resolveSolverGestureSource(feedbackClip);
  if (!clips?.length) {
    return { ...resolved, clipUrl: null };
  }
  const hit = findClipByGestureName(clips, resolved.sourceClip);
  return {
    ...resolved,
    clipUrl: hit?.clipUrl?.trim() ?? null,
  };
}

export function formatSolverGestureLabel(match: Pick<
  SolverGestureClipMatch,
  "feedbackClip" | "sourceClip" | "rotateDeg" | "synthesized"
>): string {
  return match.feedbackClip;
}
