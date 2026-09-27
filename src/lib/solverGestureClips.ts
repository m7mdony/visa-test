import type { GestureClipEntry } from "@/lib/visaflowDashboardPassports";

/** Matches `azure-liveness-automation/.../wasm_runner.cjs` GESTURE_TRANSFORM. */
export const SOLVER_GESTURE_SOURCE: Record<
  string,
  { sourceId: string; rotateDeg: number }
> = {
  upLeft: { sourceId: "up", rotateDeg: 45 },
  upRight: { sourceId: "up", rotateDeg: -45 },
  downLeft: { sourceId: "down", rotateDeg: -45 },
  downRight: { sourceId: "down", rotateDeg: 45 },
};

export type SolverGestureClipMatch = {
  /** Stuck-feedback / Azure feedback clip id (e.g. upLeft). */
  feedbackClip: string;
  /** Motion clip the solver replays from disk/cache (e.g. up). */
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

export function resolveSolverGestureSource(feedbackClip: string): {
  feedbackClip: string;
  sourceClip: string;
  rotateDeg: number;
  synthesized: boolean;
} {
  const feedback = gestureKey(feedbackClip);
  const alias =
    SOLVER_GESTURE_SOURCE[feedback] ??
    SOLVER_GESTURE_SOURCE[feedback.toLowerCase()];
  if (alias) {
    return {
      feedbackClip: feedback,
      sourceClip: alias.sourceId,
      rotateDeg: alias.rotateDeg,
      synthesized: true,
    };
  }
  return {
    feedbackClip: feedback,
    sourceClip: feedback,
    rotateDeg: 0,
    synthesized: false,
  };
}

/** Dashboard native clips; solver diagonals replay up/down + tilt (left/right are native). */
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
  if (!match.synthesized) return match.feedbackClip;
  const tilt =
    match.rotateDeg === 0
      ? ""
      : match.rotateDeg > 0
        ? `+${match.rotateDeg}°`
        : `${match.rotateDeg}°`;
  return `${match.feedbackClip} → ${match.sourceClip}${tilt ? ` (${tilt})` : ""}`;
}
