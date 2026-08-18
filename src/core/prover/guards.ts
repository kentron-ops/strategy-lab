import type { BacktestConfig, Dataset, Indicators, Strategy, Trade } from '../types'
import { runBacktest } from '../backtest/engine'
import { registerStrategy } from '../strategy/registry'
import { makeRng, sampleWithReplacement } from '../util/rng'
import { mean, quantileSorted } from '../util/stats'
import { buyAndHoldBenchmark, type Benchmark } from '../backtest/metrics'

/**
 * Statistical guards (V2 §5) — the machinery that stops the user from fooling
 * themselves. None of this is optional decoration; the Prover's verdict is
 * built on it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap CI for expectancy (in R), and the trials-adjusted p-value
// ─────────────────────────────────────────────────────────────────────────────

export interface BootstrapResult {
  point: number
  low: number
  high: number
  n: number
  iterations: number
  level: number
  /** P(mean ≤ 0) under the bootstrap distribution — one-config p-value. */
  pValue: number
  /**
   * Šidák-adjusted for the number of configurations tried:
   * p_adj = 1 − (1 − p)^trials. This is the number that answers "you tried N
   * things; how surprising is it that ONE of them looks this good?"
   */
  pValueAdjusted: number
  trials: number
}

export function bootstrapExpectancy(
  trades: Trade[],
  trials: number,
  { iterations = 2000, seed = 1337, level = 0.95 }: { iterations?: number; seed?: number; level?: number } = {},
): BootstrapResult {
  const rs = trades.filter((t) => !t.excluded).map((t) => t.r)
  const n = rs.length
  const point = mean(rs)

  if (n < 5) {
    return {
      point,
      low: Number.NEGATIVE_INFINITY,
      high: Number.POSITIVE_INFINITY,
      n,
      iterations: 0,
      level,
      pValue: 1,
      pValueAdjusted: 1,
      trials: Math.max(1, trials),
    }
  }

  const rng = makeRng(seed)
  const means: number[] = new Array(iterations)
  for (let i = 0; i < iterations; i++) {
    means[i] = mean(sampleWithReplacement(rs, n, rng))
  }
  means.sort((a, b) => a - b)

  const alpha = (1 - level) / 2
  let atOrBelowZero = 0
  for (const m of means) if (m <= 0) atOrBelowZero++
  // Add-one smoothing so a p-value is never exactly 0 from a finite bootstrap.
  const p = (atOrBelowZero + 1) / (iterations + 1)
  const T = Math.max(1, Math.round(trials))
  const pAdj = Math.min(1, 1 - Math.pow(1 - p, T))

  return {
    point,
    low: quantileSorted(means, alpha),
    high: quantileSorted(means, 1 - alpha),
    n,
    iterations,
    level,
    pValue: p,
    pValueAdjusted: pAdj,
    trials: T,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmarks: random entry at the same risk, and buy-and-hold
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Random-entry baseline: enters at random with the CANDIDATE's own exit
 * geometry and risk settings. If the candidate cannot beat a coin flip that
 * uses its own stops and targets, the entry rules contribute nothing — the
 * performance was drift or sizing, not signal.
 */
export function makeRandomEntryStrategy(seed: number): Strategy {
  const id = `random_entry_${seed}`
  const s: Strategy = {
    id,
    name: 'Random entry (benchmark)',
    description: 'Coin-flip entries with the candidate strategy’s exits and risk. A benchmark, never a candidate.',
    defaults: {
      entryProbability: 0.02,
      stopAtrMultiple: 1.5,
      targetR: 2,
      timeoutBars: 96,
      seed,
    },
    paramSpec: [],
    evaluate(ctx) {
      const p = ctx.params
      const prob = typeof p.entryProbability === 'number' ? p.entryProbability : 0.02
      const stopAtr = typeof p.stopAtrMultiple === 'number' ? p.stopAtrMultiple : 1.5
      const targetR = typeof p.targetR === 'number' ? p.targetR : 2
      const timeout = typeof p.timeoutBars === 'number' ? p.timeoutBars : 96
      const runSeed = typeof p.seed === 'number' ? p.seed : 1

      if (ctx.positions.length > 0 || ctx.pendingOrders.some((o) => o.status === 'PENDING')) {
        return { intents: [], reasons: [{ code: 'BUSY', message: 'busy', passed: false }] }
      }
      const a = ctx.ind.atr[ctx.i]
      if (a === null) {
        return { intents: [], reasons: [{ code: 'WARMUP', message: 'warmup', passed: false }] }
      }

      // Deterministic per (seed, bar): reproducible coin flips.
      const draw = makeRng((runSeed * 2654435761 + ctx.i * 40503) >>> 0)()
      if (draw >= prob) {
        return { intents: [], reasons: [{ code: 'NO_FLIP', message: 'no entry drawn', passed: false }] }
      }
      const side = makeRng((runSeed * 97 + ctx.i * 31 + 7) >>> 0)() < 0.5 ? 'LONG' : 'SHORT'
      const price = ctx.candle.c
      const stopDist = a * stopAtr
      if (!(stopDist > 0)) {
        return { intents: [], reasons: [{ code: 'BAD_STOP', message: 'bad stop', passed: false }] }
      }
      return {
        reasons: [{ code: 'RANDOM_ENTRY', message: `random ${side}`, passed: true }],
        intents: [
          {
            kind: 'PLACE',
            side,
            type: 'MARKET',
            price,
            stopLoss: side === 'LONG' ? price - stopDist : price + stopDist,
            takeProfit:
              targetR > 0
                ? side === 'LONG'
                  ? price + stopDist * targetR
                  : price - stopDist * targetR
                : null,
            timeoutBars: timeout > 0 ? timeout : null,
            ocoGroup: null,
            expiresAfterBars: 1,
            tag: 'random',
          },
        ],
      }
    },
  }
  registerStrategy(s)
  return s
}

export interface RandomBenchmarkResult {
  runs: number
  /** Expectancy (R) of each random run. */
  expectancies: number[]
  meanExpectancyR: number
  p95ExpectancyR: number
  /** Where the candidate sits among the random runs, 0..1 (1 = beat them all). */
  candidatePercentile: number
  passed: boolean
  note: string
}

export function randomEntryBenchmark(
  dataset: Dataset,
  baseConfig: BacktestConfig,
  candidate: { expectancyR: number; trades: number; avgHoldingBars: number; exposurePct: number },
  {
    runs = 40,
    seed = 7,
    exit,
    indicators,
  }: {
    runs?: number
    seed?: number
    exit: { stopAtrMultiple: number; targetR: number; timeoutBars: number }
    indicators?: Indicators
  },
): RandomBenchmarkResult {
  // Match the candidate's trade frequency so the comparison is fair.
  const bars = dataset.candles.length
  const prob = Math.min(0.5, Math.max(0.002, candidate.trades / Math.max(1, bars)))

  const expectancies: number[] = []
  for (let k = 0; k < runs; k++) {
    const strat = makeRandomEntryStrategy(seed + k)
    const cfg: BacktestConfig = {
      ...baseConfig,
      strategy: {
        id: `cfg_${strat.id}`,
        strategyId: strat.id,
        name: strat.name,
        params: {
          entryProbability: prob,
          stopAtrMultiple: exit.stopAtrMultiple,
          targetR: exit.targetR,
          timeoutBars: exit.timeoutBars,
          seed: seed + k,
        },
        lockedAt: null,
        forwardTestFrom: null,
        version: 1,
        createdAt: 0,
      },
    }
    const r = runBacktest(dataset, cfg, { indicators })
    if (r.metrics.trades >= 5) expectancies.push(r.metrics.expectancyR.point)
  }

  if (expectancies.length < 10) {
    return {
      runs: expectancies.length,
      expectancies,
      meanExpectancyR: mean(expectancies),
      p95ExpectancyR: NaN,
      candidatePercentile: NaN,
      passed: false,
      note: 'Too few usable random runs to form a null distribution — treat as failed, not as passed.',
    }
  }

  const sorted = [...expectancies].sort((a, b) => a - b)
  const p95 = quantileSorted(sorted, 0.95)
  let below = 0
  for (const e of expectancies) if (e < candidate.expectancyR) below++
  const pct = below / expectancies.length
  const passed = candidate.expectancyR > p95

  return {
    runs: expectancies.length,
    expectancies,
    meanExpectancyR: mean(expectancies),
    p95ExpectancyR: p95,
    candidatePercentile: pct,
    passed,
    note: passed
      ? `Beats ${(pct * 100).toFixed(0)}% of ${expectancies.length} random-entry runs using its own exits. The entry rules are contributing something.`
      : `Only beats ${(pct * 100).toFixed(0)}% of random-entry runs with the same exits and risk. The apparent performance is drift or exit geometry, not the entry signal.`,
  }
}

export { buyAndHoldBenchmark }
export type { Benchmark }

// ─────────────────────────────────────────────────────────────────────────────
// Outlier dependence — is the result just 1–2 lucky trades?
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlierCheck {
  expectancyR: number
  expectancyRWithoutTop1: number
  expectancyRWithoutTop2: number
  survives: boolean
  note: string
}

export function outlierDependence(trades: Trade[]): OutlierCheck {
  const rs = trades.filter((t) => !t.excluded).map((t) => t.r)
  const full = mean(rs)
  if (rs.length < 5) {
    return {
      expectancyR: full,
      expectancyRWithoutTop1: NaN,
      expectancyRWithoutTop2: NaN,
      survives: false,
      note: 'Too few trades to even ask the question.',
    }
  }
  const sorted = [...rs].sort((a, b) => b - a)
  const without1 = mean(sorted.slice(1))
  const without2 = mean(sorted.slice(2))
  const survives = without2 > 0
  return {
    expectancyR: full,
    expectancyRWithoutTop1: without1,
    expectancyRWithoutTop2: without2,
    survives,
    note: survives
      ? 'Expectancy stays positive with the two best trades removed. The edge is not one lucky candle.'
      : 'Remove the two best trades and the edge is gone. This is a story about one or two outliers, not a repeatable rule.',
  }
}
