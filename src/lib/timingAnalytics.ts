export type TimingAnalytics = {
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  outlierCount: number;
  outliers: number[];
  trimmedAvg: number | null;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function roundMs(n: number): number {
  return Math.round(n);
}

export function computeTimingAnalytics(values: number[]): TimingAnalytics | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / count;
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  const outliers = sorted.filter((v) => v < lower || v > upper);
  const trimmed = sorted.filter((v) => v >= lower && v <= upper);
  const trimmedAvg =
    trimmed.length > 0 ? trimmed.reduce((a, b) => a + b, 0) / trimmed.length : null;

  return {
    count,
    min: sorted[0],
    max: sorted[count - 1],
    avg: roundMs(avg),
    outlierCount: outliers.length,
    outliers,
    trimmedAvg: trimmedAvg != null ? roundMs(trimmedAvg) : null,
  };
}
