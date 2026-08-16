import type { Trade } from '../types'
import { makeRng, sampleWithReplacement, shuffle } from '../util/rng'
import { percentile, quantileSorted } from '../util/stats'

/**
 * Monte Carlo on the trade sequence.
 *
 * What this IS: a way to see how much of your equity curve was the ORDER the
 * trades happened to arrive in. The same set of trades, reshuffled, can produce
 * a drawdown twice as deep as the one you actually experienced. That deeper
 * drawdown was always possible; you just did not get it.
 *
 * What this IS NOT: a prediction. It resamples the past and assumes the future
 * draws from the same distribution — an assumption the brief's own first
 * principle says is false. It is a lower bound on how bad things can get, never
 * an upper bound.
 */

export type ResampleMode = 'SHUFFLE' | 'BOOTSTRAP'

export interface MonteCarloSpec {
  runs: number
  mode: ResampleMode
  /** Trades per simulated path. Defaults to the real trade count. */
  pathLength: number | null
  startingEquity: number
  seed: number
  /** Probability of ending below this fraction of starting equity. */
  ruinThresholdPct: number
}

export const DEFAULT_MONTE_CARLO: MonteCarloSpec = {
  runs: 2000,
  mode: 'BOOTSTRAP',
  pathLength: null,
  startingEquity: 200,
  seed: 42,
  ruinThresholdPct: 50,
}

export interface MonteCarloResult {
  runs: number
  mode: ResampleMode
  seed: number
  /** Percentile bands of the ending equity distribution. */
  endingEquity: Percentiles
  maxDrawdownPct: Percentiles
  consecutiveLosses: Percentiles
  /** Fraction of paths that fell below the ruin threshold at any point. */
  probabilityOfRuin: number
  probabilityOfLoss: number
  /** Equity fan: [pathIndex] of equity-by-trade, for a sample of paths. */
  fan: { p5: number[]; p25: number[]; p50: number[]; p75: number[]; p95: number[] }
  actual: { endingEquity: number; maxDrawdownPct: number; consecutiveLosses: number }
  /** Where the realised outcome sits within the simulated distribution, 0..1. */
  actualPercentile: number
  disclaimer: string
  warnings: string[]
}

export interface Percentiles {
  p5: number
  p25: number
  p50: number
  p75: number
  p95: number
  mean: number
  min: number
  max: number
}

function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  return {
    p5: quantileSorted(sorted, 0.05),
    p25: quantileSorted(sorted, 0.25),
    p50: quantileSorted(sorted, 0.5),
    p75: quantileSorted(sorted, 0.75),
    p95: quantileSorted(sorted, 0.95),
    mean: n ? sorted.reduce((a, b) => a + b, 0) / n : 0,
    min: n ? sorted[0] : 0,
    max: n ? sorted[n - 1] : 0,
  }
}

export function runMonteCarlo(
  trades: Trade[],
  spec: MonteCarloSpec = DEFAULT_MONTE_CARLO,
): MonteCarloResult {
  const warnings: string[] = []
  const pnls = trades.filter((t) => !t.excluded).map((t) => t.netPnl)

  if (pnls.length < 10) {
    warnings.push(
      `Only ${pnls.length} trades to resample. Monte Carlo on this few is just the same handful of numbers rearranged — it will look precise and mean nothing.`,
    )
  }

  const pathLength = spec.pathLength ?? pnls.length
  const rng = makeRng(spec.seed)
  const ruinLevel = (spec.startingEquity * spec.ruinThresholdPct) / 100

  const endings: number[] = []
  const drawdowns: number[] = []
  const streaks: number[] = []
  const paths: number[][] = []
  let ruined = 0
  let lost = 0

  if (!pnls.length) {
    return emptyResult(spec, warnings)
  }

  for (let run = 0; run < spec.runs; run++) {
    const seq =
      spec.mode === 'SHUFFLE'
        ? shuffle(pnls, rng).slice(0, pathLength)
        : sampleWithReplacement(pnls, pathLength, rng)

    let equity = spec.startingEquity
    let peak = equity
    let maxDdPct = 0
    let streak = 0
    let maxStreak = 0
    let hitRuin = false
    const curve: number[] = [equity]

    for (const pnl of seq) {
      equity += pnl
      curve.push(equity)
      if (equity > peak) peak = equity
      const ddPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0
      if (ddPct > maxDdPct) maxDdPct = ddPct
      if (equity <= ruinLevel) hitRuin = true
      if (pnl < 0) {
        streak += 1
        if (streak > maxStreak) maxStreak = streak
      } else streak = 0
    }

    endings.push(equity)
    drawdowns.push(maxDdPct)
    streaks.push(maxStreak)
    if (hitRuin) ruined += 1
    if (equity < spec.startingEquity) lost += 1
    if (paths.length < 400) paths.push(curve)
  }

  // Actual realised path, for comparison against the cloud.
  let actualEquity = spec.startingEquity
  let actualPeak = actualEquity
  let actualMaxDd = 0
  let actualStreak = 0
  let actualMaxStreak = 0
  for (const pnl of pnls) {
    actualEquity += pnl
    if (actualEquity > actualPeak) actualPeak = actualEquity
    const ddPct = actualPeak > 0 ? ((actualPeak - actualEquity) / actualPeak) * 100 : 0
    if (ddPct > actualMaxDd) actualMaxDd = ddPct
    if (pnl < 0) {
      actualStreak += 1
      if (actualStreak > actualMaxStreak) actualMaxStreak = actualStreak
    } else actualStreak = 0
  }

  return {
    runs: spec.runs,
    mode: spec.mode,
    seed: spec.seed,
    endingEquity: percentiles(endings),
    maxDrawdownPct: percentiles(drawdowns),
    consecutiveLosses: percentiles(streaks),
    probabilityOfRuin: ruined / spec.runs,
    probabilityOfLoss: lost / spec.runs,
    fan: buildFan(paths, pathLength + 1),
    actual: {
      endingEquity: actualEquity,
      maxDrawdownPct: actualMaxDd,
      consecutiveLosses: actualMaxStreak,
    },
    actualPercentile: percentileOf(endings, actualEquity),
    disclaimer:
      'Resampling of past trades. It assumes the future draws from the same distribution, which the market does not promise. Read it as "how bad could the same edge have felt", never as a forecast.',
    warnings,
  }
}

function buildFan(
  paths: number[][],
  length: number,
): { p5: number[]; p25: number[]; p50: number[]; p75: number[]; p95: number[] } {
  const p5: number[] = []
  const p25: number[] = []
  const p50: number[] = []
  const p75: number[] = []
  const p95: number[] = []

  for (let step = 0; step < length; step++) {
    const slice: number[] = []
    for (const p of paths) if (step < p.length) slice.push(p[step])
    if (!slice.length) break
    const sorted = slice.sort((a, b) => a - b)
    p5.push(quantileSorted(sorted, 0.05))
    p25.push(quantileSorted(sorted, 0.25))
    p50.push(quantileSorted(sorted, 0.5))
    p75.push(quantileSorted(sorted, 0.75))
    p95.push(quantileSorted(sorted, 0.95))
  }

  return { p5, p25, p50, p75, p95 }
}

function percentileOf(values: number[], target: number): number {
  if (!values.length) return 0
  let below = 0
  for (const v of values) if (v < target) below += 1
  return below / values.length
}

function emptyResult(spec: MonteCarloSpec, warnings: string[]): MonteCarloResult {
  const zero: Percentiles = { p5: 0, p25: 0, p50: 0, p75: 0, p95: 0, mean: 0, min: 0, max: 0 }
  return {
    runs: 0,
    mode: spec.mode,
    seed: spec.seed,
    endingEquity: zero,
    maxDrawdownPct: zero,
    consecutiveLosses: zero,
    probabilityOfRuin: 0,
    probabilityOfLoss: 0,
    fan: { p5: [], p25: [], p50: [], p75: [], p95: [] },
    actual: { endingEquity: spec.startingEquity, maxDrawdownPct: 0, consecutiveLosses: 0 },
    actualPercentile: 0,
    disclaimer: 'No trades to resample.',
    warnings: [...warnings, 'No trades to resample.'],
  }
}

/** Convenience for the UI's headline sentence. */
export function summariseMonteCarlo(r: MonteCarloResult): string {
  if (!r.runs) return 'Nothing to simulate.'
  return [
    `Across ${r.runs.toLocaleString()} reshuffles of the same trades, the middle half of outcomes ended between ${r.endingEquity.p25.toFixed(0)} and ${r.endingEquity.p75.toFixed(0)}.`,
    `The worst 5% saw drawdowns beyond ${r.maxDrawdownPct.p95.toFixed(1)}% and losing streaks of ${Math.round(r.consecutiveLosses.p95)} or more.`,
    r.probabilityOfRuin > 0
      ? `${(r.probabilityOfRuin * 100).toFixed(1)}% of paths touched the ruin threshold at some point.`
      : 'No path touched the ruin threshold.',
    `The run you actually got sits at the ${(r.actualPercentile * 100).toFixed(0)}th percentile of this cloud.`,
  ].join(' ')
}
