import type { BacktestConfig, BacktestResult, Dataset, Indicators } from '../types'
import type { AcceptIf } from '../spec/types'
import { runBacktest } from '../backtest/engine'
import { computeIndicators } from '../indicators'
import { splitTest, runWalkForward } from '../optimization/walkForward'
import { testRobustness } from '../optimization/robustness'
import { runMonteCarlo } from '../optimization/monteCarlo'
import { resolveStrategyConfig } from '../spec/resolve'
import { getStrategy } from '../strategy/registry'
import {
  bootstrapExpectancy,
  buyAndHoldBenchmark,
  outlierDependence,
  randomEntryBenchmark,
  type BootstrapResult,
  type OutlierCheck,
  type RandomBenchmarkResult,
} from './guards'
import type { Benchmark } from '../backtest/metrics'

/**
 * The Edge Prover (V2 §5).
 *
 * Runs a candidate through seven gates and the statistical guards, and returns
 * PROVEN / INSUFFICIENT_EVIDENCE / NOT_PROVEN with a per-gate evidence card.
 *
 * Vocabulary note, and it matters: PROVEN here means "survived every honest
 * test we know how to run on the past". It is a statement about evidence, not
 * about the future. The word "certain" does not appear in this file or its
 * output, by design.
 */

export type GateStatus = 'PASS' | 'FAIL' | 'PENDING' | 'SKIPPED'

export interface GateResult {
  id: number
  key: string
  name: string
  status: GateStatus
  summary: string
  numbers: Record<string, number | string>
}

export type ProofVerdict = 'PROVEN' | 'INSUFFICIENT_EVIDENCE' | 'NOT_PROVEN'
export type ConfidenceGrade = 'A' | 'B' | 'C' | 'D'

export interface ProofResult {
  verdict: ProofVerdict
  grade: ConfidenceGrade
  gates: GateResult[]
  guards: {
    bootstrap: BootstrapResult
    outliers: OutlierCheck
    randomBenchmark: RandomBenchmarkResult
    buyAndHold: Benchmark
    acceptIf: AcceptIf
    acceptIfHeld: boolean
    trials: number
  }
  headline: string
  /** Full-data run the gates were anchored on. */
  baseline: {
    trades: number
    expectancyR: number
    netPnl: number
    maxDrawdownPct: number
    datasetHash: string
    symbol: string
  }
  computedAt: number
  durationMs: number
  warnings: string[]
}

export interface ProverOptions {
  trials: number
  acceptIf: AcceptIf
  /** Split ratio for gate 1. */
  isRatio?: number
  /** Walk-forward geometry; embargo defaults to the max holding period. */
  wfTrainBars?: number
  wfTestBars?: number
  costStressFactor?: number
  mcRuns?: number
  randomRuns?: number
  seed?: number
  onProgress?: (stage: string, fraction: number) => void
  shouldAbort?: () => boolean
  indicators?: Indicators
}

export function proveEdge(
  dataset: Dataset,
  configIn: BacktestConfig,
  opts: ProverOptions,
): ProofResult {
  const started = Date.now()
  const warnings: string[] = []
  const progress = (stage: string, f: number): void => opts.onProgress?.(stage, f)

  const config: BacktestConfig = {
    ...configIn,
    strategy: resolveStrategyConfig(configIn.strategy),
    fromIndex: null,
    toIndex: null,
  }
  const ind =
    opts.indicators ?? computeIndicators(dataset.candles, config.indicators, dataset.timeframe)

  const gates: GateResult[] = []
  const gate = (
    id: number,
    key: string,
    name: string,
    status: GateStatus,
    summary: string,
    numbers: Record<string, number | string> = {},
  ): void => {
    gates.push({ id, key, name, status, summary, numbers })
  }

  // ── baseline full-data run ──────────────────────────────────────────────────
  progress('baseline', 0)
  const full = runBacktest(dataset, config, { indicators: ind })
  const m = full.metrics
  const baseline = {
    trades: m.trades,
    expectancyR: m.expectancyR.point,
    netPnl: m.netPnl,
    maxDrawdownPct: m.maxDrawdownPct,
    datasetHash: dataset.hash,
    symbol: dataset.symbol,
  }

  const timeoutParam = numericParam(config, ['timeoutBars', 'spec_timeoutBars'])
  const maxHoldBars = Math.max(
    Math.round(timeoutParam ?? 0),
    Math.round(p95(full.trades.map((t) => t.barsHeld))) || 0,
    1,
  )

  // ── gate 5 first: sample adequacy governs whether the rest can even speak ──
  progress('sample', 0.08)
  const outliers = outlierDependence(full.trades)
  const minTrades = Math.max(opts.acceptIf.minTrades, 30)
  if (m.trades < minTrades) {
    gate(5, 'sample', 'Sample adequacy', 'FAIL',
      `${m.trades} trades against a floor of ${minTrades}. Nothing downstream can be trusted at this sample size.`,
      { trades: m.trades, required: minTrades })
  } else if (!outliers.survives) {
    gate(5, 'sample', 'Sample adequacy', 'FAIL', outliers.note, {
      trades: m.trades,
      expectancyR: round4(outliers.expectancyR),
      withoutTop2: round4(outliers.expectancyRWithoutTop2),
    })
  } else {
    gate(5, 'sample', 'Sample adequacy', 'PASS',
      `${m.trades} trades; expectancy survives removal of the two best (${round4(outliers.expectancyRWithoutTop2)}R).`,
      { trades: m.trades, withoutTop2: round4(outliers.expectancyRWithoutTop2) })
  }
  const sampleOk = gates[gates.length - 1].status === 'PASS'

  // ── gate 1: out-of-sample split ────────────────────────────────────────────
  progress('oos', 0.15)
  const split = splitTest(dataset, config, opts.isRatio ?? 0.7, 'expectancyR', ind)
  const oosLow = split.outOfSample.expectancyR.low
  if (split.outOfSample.trades < 10) {
    gate(1, 'oos', 'Out-of-sample', 'FAIL',
      `Only ${split.outOfSample.trades} out-of-sample trades — the split cannot confirm anything.`,
      { oosTrades: split.outOfSample.trades })
  } else if (oosLow > 0) {
    gate(1, 'oos', 'Out-of-sample', 'PASS',
      `OOS expectancy ${round4(split.outOfSample.expectancyR.point)}R, CI low ${round4(oosLow)}R — the interval clears zero.`,
      { oosExpectancyR: round4(split.outOfSample.expectancyR.point), ciLow: round4(oosLow), oosTrades: split.outOfSample.trades })
  } else {
    gate(1, 'oos', 'Out-of-sample', 'FAIL',
      `OOS expectancy CI [${round4(oosLow)}, ${round4(split.outOfSample.expectancyR.high)}]R does not clear zero. ${split.verdict}`,
      { oosExpectancyR: round4(split.outOfSample.expectancyR.point), ciLow: round4(oosLow) })
  }

  // ── gate 2: purged walk-forward ────────────────────────────────────────────
  progress('walkforward', 0.3)
  if (opts.shouldAbort?.()) warnings.push('Aborted during walk-forward.')
  const strategy = getStrategy(config.strategy.strategyId)
  const wfDims = strategy.paramSpec
    .filter((ps) => ps.sweep)
    .slice(0, 2)
    .map((ps) => ({
      key: ps.key,
      values: threePoint(config.strategy.params[ps.key] as number, ps.sweep!),
    }))
  const bars = dataset.candles.length
  const trainBars = opts.wfTrainBars ?? Math.max(500, Math.floor(bars * 0.25))
  const testBars = opts.wfTestBars ?? Math.max(200, Math.floor(bars * 0.1))
  const wf = runWalkForward(
    dataset,
    config,
    {
      dimensions: wfDims.length ? wfDims : [{ key: '__none', values: [0] }],
      trainBars,
      testBars,
      embargoBars: maxHoldBars,
      objective: 'expectancyR',
      minTrainTrades: 5,
    },
    { indicators: ind, shouldAbort: opts.shouldAbort },
  )
  if (wf.windows.length < 3) {
    gate(2, 'walkforward', 'Purged walk-forward', 'FAIL',
      `Only ${wf.windows.length} usable window(s) — not enough data to walk forward honestly.`,
      { windows: wf.windows.length, embargoBars: maxHoldBars })
  } else if (wf.aggregate.expectancyR > 0 && wf.consistency >= 0.5 && !wf.flags.includes('POSSIBLE_OVERFIT')) {
    gate(2, 'walkforward', 'Purged walk-forward', 'PASS',
      `${Math.round(wf.consistency * wf.windows.length)}/${wf.windows.length} windows profitable forward at ${round4(wf.aggregate.expectancyR)}R, embargo ${maxHoldBars} bars.`,
      { windows: wf.windows.length, consistency: round4(wf.consistency), fwdExpectancyR: round4(wf.aggregate.expectancyR), embargoBars: maxHoldBars })
  } else {
    gate(2, 'walkforward', 'Purged walk-forward', 'FAIL', wf.verdict,
      { windows: wf.windows.length, consistency: round4(wf.consistency), fwdExpectancyR: round4(wf.aggregate.expectancyR) })
  }

  // ── gate 3: robustness ─────────────────────────────────────────────────────
  progress('robustness', 0.55)
  const rob = testRobustness(dataset, config, { steps: [0.1, 0.25], objective: 'expectancyR' }, ind)
  if (!rob.neighbours.length) {
    gate(3, 'robustness', 'Neighbourhood robustness', 'SKIPPED', rob.verdict)
  } else if (rob.flags.includes('FRAGILE') || rob.centre.score <= 0) {
    gate(3, 'robustness', 'Neighbourhood robustness', 'FAIL', rob.verdict,
      { retention: round4(rob.retention), neighbours: rob.neighbours.length })
  } else {
    gate(3, 'robustness', 'Neighbourhood robustness', 'PASS', rob.verdict,
      { retention: round4(rob.retention), neighbours: rob.neighbours.length })
  }

  // ── gate 4: Monte Carlo ────────────────────────────────────────────────────
  progress('montecarlo', 0.7)
  const mc = runMonteCarlo(full.trades, {
    runs: opts.mcRuns ?? 2000,
    mode: 'BOOTSTRAP',
    pathLength: null,
    startingEquity: config.risk.startingEquity,
    seed: opts.seed ?? 42,
    ruinThresholdPct: config.risk.equityFloorPercent ?? 50,
  })
  if (!mc.runs) {
    gate(4, 'montecarlo', 'Monte Carlo', 'SKIPPED', 'No trades to resample.')
  } else if (mc.probabilityOfLoss <= 0.35 && mc.probabilityOfRuin <= 0.05) {
    gate(4, 'montecarlo', 'Monte Carlo', 'PASS',
      `${((1 - mc.probabilityOfLoss) * 100).toFixed(0)}% of ${mc.runs} resamples end positive; ruin probability ${(mc.probabilityOfRuin * 100).toFixed(1)}%; p95 drawdown ${mc.maxDrawdownPct.p95.toFixed(1)}%.`,
      { pLoss: round4(mc.probabilityOfLoss), pRuin: round4(mc.probabilityOfRuin), p95DrawdownPct: round4(mc.maxDrawdownPct.p95) })
  } else {
    gate(4, 'montecarlo', 'Monte Carlo', 'FAIL',
      `${(mc.probabilityOfLoss * 100).toFixed(0)}% of resamples end at a loss and ruin probability is ${(mc.probabilityOfRuin * 100).toFixed(1)}%. The same trades, reordered, are too likely to hurt.`,
      { pLoss: round4(mc.probabilityOfLoss), pRuin: round4(mc.probabilityOfRuin) })
  }

  // ── gate 6: cost stress ────────────────────────────────────────────────────
  progress('coststress', 0.8)
  const factor = opts.costStressFactor ?? 1.5
  const stressed = runBacktest(
    dataset,
    {
      ...config,
      costs: {
        ...config.costs,
        spread: config.costs.spread * factor,
        slippage: config.costs.slippage * factor,
        spreadAtrMultiple: config.costs.spreadAtrMultiple * factor,
        slippageAtrMultiple: config.costs.slippageAtrMultiple * factor,
      },
    },
    { indicators: ind },
  )
  if (stressed.metrics.trades === 0) {
    gate(6, 'coststress', 'Cost stress', 'SKIPPED', 'No trades under stressed costs.')
  } else if (stressed.metrics.expectancyR.point > 0) {
    gate(6, 'coststress', 'Cost stress', 'PASS',
      `Expectancy holds at ${round4(stressed.metrics.expectancyR.point)}R with spread and slippage ×${factor}.`,
      { stressedExpectancyR: round4(stressed.metrics.expectancyR.point), factor })
  } else {
    gate(6, 'coststress', 'Cost stress', 'FAIL',
      `Raise spread and slippage ×${factor} and the edge dies (${round4(stressed.metrics.expectancyR.point)}R). It lives inside the cost assumptions, not the market.`,
      { stressedExpectancyR: round4(stressed.metrics.expectancyR.point), factor })
  }

  // ── gate 7: forward test ───────────────────────────────────────────────────
  progress('forward', 0.85)
  const lockFrom = config.strategy.forwardTestFrom
  if (lockFrom && dataset.candles.some((c) => c.t > lockFrom)) {
    const idx = dataset.candles.findIndex((c) => c.t > lockFrom)
    const fwd = runBacktest(dataset, { ...config, fromIndex: idx, toIndex: null }, { indicators: ind })
    if (fwd.metrics.trades < 20) {
      gate(7, 'forward', 'Forward test', 'PENDING',
        `${fwd.metrics.trades} trades since the lock date — keep it running; 20+ needed before this gate speaks.`,
        { forwardTrades: fwd.metrics.trades })
    } else if (fwd.metrics.expectancyR.point > 0) {
      gate(7, 'forward', 'Forward test', 'PASS',
        `${round4(fwd.metrics.expectancyR.point)}R over ${fwd.metrics.trades} trades on data after the lock date.`,
        { forwardExpectancyR: round4(fwd.metrics.expectancyR.point), forwardTrades: fwd.metrics.trades })
    } else {
      gate(7, 'forward', 'Forward test', 'FAIL',
        `Negative on post-lock data (${round4(fwd.metrics.expectancyR.point)}R over ${fwd.metrics.trades} trades). The past agreed; the present does not.`,
        { forwardExpectancyR: round4(fwd.metrics.expectancyR.point), forwardTrades: fwd.metrics.trades })
    }
  } else {
    gate(7, 'forward', 'Forward test', 'PENDING',
      'Lock the strategy, let fresh data accumulate, then re-prove. No amount of history substitutes for this gate.')
  }

  // ── guards ─────────────────────────────────────────────────────────────────
  progress('guards', 0.9)
  const trials = Math.max(1, Math.round(opts.trials))
  const bootstrap = bootstrapExpectancy(full.trades, trials, { seed: opts.seed ?? 1337 })
  const bh = buyAndHoldBenchmark(dataset.candles, config.risk.startingEquity)
  const exitGeom = {
    stopAtrMultiple: numericParam(config, ['stopAtrMultiple', 'spec_stopValue']) ?? 1.5,
    targetR: numericParam(config, ['targetR', 'spec_targetValue']) ?? 2,
    timeoutBars: Math.round(timeoutParam ?? 96),
  }
  const randomBm = sampleOk
    ? randomEntryBenchmark(dataset, config, {
        expectancyR: m.expectancyR.point,
        trades: m.trades,
        avgHoldingBars: m.avgHoldingBars,
        exposurePct: m.exposurePct,
      }, { runs: opts.randomRuns ?? 40, seed: opts.seed ?? 7, exit: exitGeom, indicators: ind })
    : {
        runs: 0, expectancies: [], meanExpectancyR: 0, p95ExpectancyR: NaN,
        candidatePercentile: NaN, passed: false,
        note: 'Skipped — the sample gate already failed.',
      }

  const acceptIfHeld =
    m.trades >= opts.acceptIf.minTrades && m.expectancyR.point >= opts.acceptIf.minExpectancyR

  // ── verdict ────────────────────────────────────────────────────────────────
  const byKey = new Map(gates.map((g) => [g.key, g]))
  const hardGates = ['oos', 'walkforward', 'sample', 'coststress'] as const
  const anyHardFail = hardGates.some((k) => byKey.get(k)?.status === 'FAIL')
  const softFail =
    byKey.get('robustness')?.status === 'FAIL' || byKey.get('montecarlo')?.status === 'FAIL'
  const guardsFail =
    bootstrap.pValueAdjusted >= 0.05 || !randomBm.passed || !acceptIfHeld
  const thin = m.trades < minTrades || (byKey.get('oos')?.numbers.oosTrades as number ?? 99) < 10

  let verdict: ProofVerdict
  if (m.trades === 0) verdict = 'INSUFFICIENT_EVIDENCE'
  else if (thin && !anyHardFail && m.expectancyR.point > 0) verdict = 'INSUFFICIENT_EVIDENCE'
  else if (anyHardFail || guardsFail || softFail) verdict = 'NOT_PROVEN'
  else verdict = 'PROVEN'

  const passCount = gates.filter((g) => g.status === 'PASS').length
  const forwardPassed = byKey.get('forward')?.status === 'PASS'
  let grade: ConfidenceGrade
  if (verdict !== 'PROVEN') grade = verdict === 'NOT_PROVEN' ? 'D' : 'C'
  else if (forwardPassed && passCount === 7 && bootstrap.pValueAdjusted < 0.01) grade = 'A'
  else grade = 'B'

  const headline =
    verdict === 'PROVEN'
      ? `PROVEN (grade ${grade}) after ${trials.toLocaleString()} tried configuration(s): every completed gate passed and the trials-adjusted p-value is ${bootstrap.pValueAdjusted.toFixed(4)}. This is evidence about the past, not a promise about the future${forwardPassed ? '' : ' — the forward-test gate is still pending, which caps the grade at B'}.`
      : verdict === 'INSUFFICIENT_EVIDENCE'
        ? `INSUFFICIENT EVIDENCE: the numbers lean positive but the sample cannot carry the claim. More data or a less selective rule — not more optimism.`
        : `NOT PROVEN after ${trials.toLocaleString()} tried configuration(s). ${firstFailure(gates, bootstrap, randomBm, acceptIfHeld)}`

  progress('done', 1)
  return {
    verdict,
    grade,
    gates: gates.sort((a, b) => a.id - b.id),
    guards: { bootstrap, outliers, randomBenchmark: randomBm, buyAndHold: bh, acceptIf: opts.acceptIf, acceptIfHeld, trials },
    headline,
    baseline,
    computedAt: Date.now(),
    durationMs: Date.now() - started,
    warnings: [...warnings, ...full.warnings.filter((w) => w.startsWith('INVARIANT'))],
  }
}

function firstFailure(
  gates: GateResult[],
  bootstrap: BootstrapResult,
  randomBm: RandomBenchmarkResult,
  acceptIfHeld: boolean,
): string {
  const failed = gates.find((g) => g.status === 'FAIL')
  if (failed) return `${failed.name}: ${failed.summary}`
  if (bootstrap.pValueAdjusted >= 0.05) {
    return `After adjusting for ${bootstrap.trials} trials, the probability this expectancy arose by luck is ${(bootstrap.pValueAdjusted * 100).toFixed(1)}% — too high to call an edge.`
  }
  if (!randomBm.passed) return randomBm.note
  if (!acceptIfHeld) return 'The result does not meet the pre-registered AcceptIf thresholds you set before testing.'
  return 'A guard failed.'
}

function numericParam(config: BacktestConfig, keys: string[]): number | null {
  for (const k of keys) {
    const v = config.strategy.params[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

function threePoint(centre: number, sweep: { from: number; to: number; step: number }): number[] {
  if (typeof centre !== 'number' || !Number.isFinite(centre)) return [sweep.from, sweep.to]
  const lo = Math.max(sweep.from, centre - sweep.step)
  const hi = Math.min(sweep.to, centre + sweep.step)
  return [...new Set([lo, centre, hi])]
}

function p95(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000
