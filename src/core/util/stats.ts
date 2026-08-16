/** Small statistics helpers. Pure, no dependencies. */

export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

export const mean = (xs: number[]): number => (xs.length ? sum(xs) / xs.length : 0)

/** Sample standard deviation (n-1). Returns 0 for n < 2. */
export function stdev(xs: number[]): number {
  const n = xs.length
  if (n < 2) return 0
  const m = mean(xs)
  let acc = 0
  for (const x of xs) acc += (x - m) * (x - m)
  return Math.sqrt(acc / (n - 1))
}

/** Downside deviation against a target (used for Sortino). */
export function downsideDeviation(xs: number[], target = 0): number {
  const n = xs.length
  if (n < 2) return 0
  let acc = 0
  for (const x of xs) {
    const d = Math.min(0, x - target)
    acc += d * d
  }
  return Math.sqrt(acc / (n - 1))
}

/** Linear-interpolated percentile. `p` in [0,1]. Input need not be sorted. */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const idx = (s.length - 1) * Math.min(1, Math.max(0, p))
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return s[lo]
  return s[lo] + (s[hi] - s[lo]) * (idx - lo)
}

/** Fraction of `xs` strictly below `value`, in [0,1]. */
export function percentileRank(xs: number[], value: number): number {
  if (!xs.length) return NaN
  let below = 0
  for (const x of xs) if (x < value) below++
  return below / xs.length
}

export function quantileSorted(sorted: number[], p: number): number {
  if (!sorted.length) return NaN
  const idx = (sorted.length - 1) * Math.min(1, Math.max(0, p))
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/**
 * Wilson score interval for a proportion. Correct at small n, unlike the
 * normal approximation — which matters because the whole app is about being
 * honest when the sample is thin.
 */
export function wilsonInterval(
  successes: number,
  n: number,
  level = 0.95,
): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 }
  const z = zForLevel(level)
  const p = successes / n
  const denom = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return {
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
  }
}

/**
 * Confidence interval for a mean using the t distribution.
 * Falls back to a wide-open interval below n = 2, because a single sample
 * tells you nothing and must not look like it does.
 */
export function meanInterval(
  xs: number[],
  level = 0.95,
): { point: number; low: number; high: number } {
  const n = xs.length
  const m = mean(xs)
  if (n < 2) {
    return { point: m, low: Number.NEGATIVE_INFINITY, high: Number.POSITIVE_INFINITY }
  }
  const se = stdev(xs) / Math.sqrt(n)
  const t = tCritical(n - 1, level)
  return { point: m, low: m - t * se, high: m + t * se }
}

function zForLevel(level: number): number {
  if (level >= 0.995) return 2.807
  if (level >= 0.99) return 2.576
  if (level >= 0.975) return 2.241
  if (level >= 0.95) return 1.96
  if (level >= 0.9) return 1.645
  return 1.96
}

/**
 * Two-sided t critical value. Table for small df (where it actually matters),
 * normal approximation above 30.
 */
export function tCritical(df: number, level = 0.95): number {
  const table95: Record<number, number> = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
    8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145,
    15: 2.131, 16: 2.12, 17: 2.11, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.08,
    22: 2.074, 23: 2.069, 24: 2.064, 25: 2.06, 26: 2.056, 27: 2.052, 28: 2.048,
    29: 2.045, 30: 2.042,
  }
  const z = zForLevel(level)
  if (df <= 0) return z * 10
  if (level >= 0.94 && level <= 0.96 && table95[df] !== undefined) return table95[df]
  if (df > 30) return z
  // Scale the 95% table by the ratio of z values for other levels.
  const base = table95[df] ?? z
  return (base * z) / 1.96
}

/**
 * Kelly fraction from win rate and payoff ratio (avgWin / avgLoss, both > 0).
 * Returns 0 when the edge is non-positive. Full Kelly is aggressive to the point
 * of being irresponsible; callers are expected to apply a fraction.
 */
export function kellyFraction(winRate: number, payoffRatio: number): number {
  if (payoffRatio <= 0) return 0
  const f = winRate - (1 - winRate) / payoffRatio
  return Math.max(0, f)
}

export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x))

export function round(x: number, decimals: number): number {
  const f = Math.pow(10, decimals)
  return Math.round(x * f) / f
}

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}
