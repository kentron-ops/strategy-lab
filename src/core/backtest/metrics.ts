import type {
  ConfidenceInterval,
  EquityPoint,
  Metrics,
  Trade,
} from '../types'
import { MIN_MEANINGFUL_TRADES } from '../types'
import {
  downsideDeviation,
  mean,
  meanInterval,
  stdev,
  sum,
  wilsonInterval,
} from '../util/stats'

/**
 * Metrics.
 *
 * Two rules govern this file:
 *   1. Anything probabilistic carries its sample size and a confidence range.
 *      A win rate without an `n` is a decoration, not a measurement.
 *   2. Nothing is annualised or Sharpe-ratio'd without the assumption being
 *      written down in the output, because those assumptions are usually where
 *      a flattering number comes from.
 */

export interface MetricsExtras {
  barsInPosition: number
  totalBars: number
}

const EMPTY_CI = (n: number): ConfidenceInterval => ({
  point: 0,
  low: 0,
  high: 0,
  n,
  level: 0.95,
})

export function computeMetrics(
  trades: Trade[],
  equityCurve: EquityPoint[],
  startingEquity: number,
  extras: MetricsExtras,
): Metrics {
  const n = trades.length
  const rs = trades.map((t) => t.r)
  const pnls = trades.map((t) => t.netPnl)

  const wins = trades.filter((t) => t.netPnl > 0)
  const losses = trades.filter((t) => t.netPnl < 0)
  const flat = trades.filter((t) => t.netPnl === 0)

  const grossProfit = sum(wins.map((t) => t.netPnl))
  const grossLoss = Math.abs(sum(losses.map((t) => t.netPnl)))

  const netPnl = sum(pnls)
  const endingEquity = startingEquity + netPnl

  const winRateCi = wilsonInterval(wins.length, n, 0.95)
  const winRate: ConfidenceInterval =
    n > 0
      ? { point: wins.length / n, low: winRateCi.low, high: winRateCi.high, n, level: 0.95 }
      : EMPTY_CI(0)

  const rCi = meanInterval(rs, 0.95)
  const expectancyR: ConfidenceInterval =
    n > 0
      ? { point: rCi.point, low: rCi.low, high: rCi.high, n, level: 0.95 }
      : EMPTY_CI(0)

  let maxDrawdown = 0
  let maxDrawdownPct = 0
  for (const p of equityCurve) {
    if (p.drawdown > maxDrawdown) maxDrawdown = p.drawdown
    if (p.drawdownPct > maxDrawdownPct) maxDrawdownPct = p.drawdownPct
  }

  const streaks = consecutiveStreaks(trades)

  const rSd = stdev(rs)
  const rDd = downsideDeviation(rs, 0)
  const spanMs =
    trades.length > 1 ? trades[trades.length - 1].exitTime - trades[0].entryTime : 0
  const years = spanMs > 0 ? spanMs / (365.25 * 24 * 3600 * 1000) : 0
  const tradesPerYear = years > 0 ? n / years : 0
  const scale = tradesPerYear > 0 ? Math.sqrt(tradesPerYear) : 0

  const sharpe = rSd > 0 && scale > 0 ? (mean(rs) / rSd) * scale : 0
  const sortino = rDd > 0 && scale > 0 ? (mean(rs) / rDd) * scale : 0

  const totalCosts = sum(trades.map((t) => t.costs))
  const grossPnlTotal = sum(trades.map((t) => t.grossPnl))
  const grossProfitBeforeCosts = sum(
    trades.filter((t) => t.grossPnl > 0).map((t) => t.grossPnl),
  )

  return {
    startingEquity,
    endingEquity,
    netPnl,
    returnPct: startingEquity > 0 ? (netPnl / startingEquity) * 100 : 0,

    trades: n,
    wins: wins.length,
    losses: losses.length,
    breakEven: flat.length,
    winRate,

    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    avgR: mean(rs),
    expectancy: n ? netPnl / n : 0,
    expectancyR,

    profitFactor:
      grossLoss > 0
        ? grossProfit / grossLoss
        : grossProfit > 0
          ? Number.POSITIVE_INFINITY
          : 0,
    maxDrawdown,
    maxDrawdownPct,
    returnOverMaxDD: maxDrawdown > 0 ? netPnl / maxDrawdown : 0,

    bestTrade: n ? Math.max(...pnls) : 0,
    worstTrade: n ? Math.min(...pnls) : 0,
    maxConsecutiveWins: streaks.maxWins,
    maxConsecutiveLosses: streaks.maxLosses,

    avgHoldingBars: n ? mean(trades.map((t) => t.barsHeld)) : 0,
    avgHoldingMs: n ? mean(trades.map((t) => t.holdingMs)) : 0,
    exposurePct:
      extras.totalBars > 0 ? (extras.barsInPosition / extras.totalBars) * 100 : 0,

    grossPnl: grossPnlTotal,
    totalCosts,
    costPctOfGrossProfit:
      grossProfitBeforeCosts > 0 ? (totalCosts / grossProfitBeforeCosts) * 100 : 0,

    sharpe,
    sortino,
    sharpeAssumption:
      tradesPerYear > 0
        ? `Per-trade R series scaled by √(${tradesPerYear.toFixed(1)} trades/year), zero risk-free rate, trades assumed independent. Not comparable to a buy-and-hold Sharpe.`
        : 'Not computable — the trade history spans no measurable time.',

    avgMfeR: n ? mean(trades.map((t) => t.mfeR)) : 0,
    avgMaeR: n ? mean(trades.map((t) => t.maeR)) : 0,

    sampleAdequate: n >= MIN_MEANINGFUL_TRADES,
    sampleThreshold: MIN_MEANINGFUL_TRADES,
  }
}

function consecutiveStreaks(trades: Trade[]): { maxWins: number; maxLosses: number } {
  let maxWins = 0
  let maxLosses = 0
  let curWins = 0
  let curLosses = 0
  for (const t of trades) {
    if (t.netPnl > 0) {
      curWins += 1
      curLosses = 0
    } else if (t.netPnl < 0) {
      curLosses += 1
      curWins = 0
    } else {
      curWins = 0
      curLosses = 0
    }
    if (curWins > maxWins) maxWins = curWins
    if (curLosses > maxLosses) maxLosses = curLosses
  }
  return { maxWins, maxLosses }
}

/** Empty metrics for the "nothing computed yet" UI state. */
export function emptyMetrics(startingEquity: number): Metrics {
  return computeMetrics([], [], startingEquity, { barsInPosition: 0, totalBars: 0 })
}

// ─────────────────────────────────────────────────────────────────────────────
// Slices — where the edge lives and where it dies (§8)
// ─────────────────────────────────────────────────────────────────────────────

export interface Slice {
  key: string
  label: string
  trades: number
  winRate: ConfidenceInterval
  expectancyR: ConfidenceInterval
  netPnl: number
  profitFactor: number
  avgR: number
  /** Below this, the slice is shown as "insufficient evidence", not ranked. */
  adequate: boolean
}

export function sliceBy(
  trades: Trade[],
  keyOf: (t: Trade) => string,
  labelOf: (key: string) => string = (k) => k,
  minSample = 10,
): Slice[] {
  const groups = new Map<string, Trade[]>()
  for (const t of trades) {
    const k = keyOf(t)
    const arr = groups.get(k)
    if (arr) arr.push(t)
    else groups.set(k, [t])
  }

  const out: Slice[] = []
  for (const [key, ts] of groups) {
    const rs = ts.map((t) => t.r)
    const wins = ts.filter((t) => t.netPnl > 0).length
    const wr = wilsonInterval(wins, ts.length, 0.95)
    const ci = meanInterval(rs, 0.95)
    const grossProfit = sum(ts.filter((t) => t.netPnl > 0).map((t) => t.netPnl))
    const grossLoss = Math.abs(sum(ts.filter((t) => t.netPnl < 0).map((t) => t.netPnl)))
    out.push({
      key,
      label: labelOf(key),
      trades: ts.length,
      winRate: {
        point: ts.length ? wins / ts.length : 0,
        low: wr.low,
        high: wr.high,
        n: ts.length,
        level: 0.95,
      },
      expectancyR: {
        point: ci.point,
        low: ci.low,
        high: ci.high,
        n: ts.length,
        level: 0.95,
      },
      netPnl: sum(ts.map((t) => t.netPnl)),
      profitFactor:
        grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      avgR: mean(rs),
      adequate: ts.length >= minSample,
    })
  }

  return out.sort((a, b) => b.expectancyR.point - a.expectancyR.point)
}

/**
 * Benchmarks (§13). An equity curve that looks good means nothing until you know
 * what doing nothing, or doing something random, would have produced.
 */
export interface Benchmark {
  label: string
  netPnl: number
  returnPct: number
  note: string
}

export function buyAndHoldBenchmark(
  candles: { c: number }[],
  startingEquity: number,
): Benchmark {
  if (candles.length < 2) {
    return { label: 'Buy and hold', netPnl: 0, returnPct: 0, note: 'Not enough data.' }
  }
  const first = candles[0].c
  const last = candles[candles.length - 1].c
  const returnPct = ((last - first) / first) * 100
  return {
    label: 'Buy and hold',
    netPnl: (startingEquity * returnPct) / 100,
    returnPct,
    note: 'Full equity in the instrument for the whole period, no costs, no stop. Shown so market drift is not mistaken for edge.',
  }
}
