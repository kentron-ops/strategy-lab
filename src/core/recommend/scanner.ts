import type {
  BacktestConfig,
  Candle,
  Indicators,
  Instrument,
  Intent,
  Reason,
  Regime,
  Session,
  Side,
  StrategyConfig,
} from '../types'
import { getStrategy, hydrateConfig } from '../strategy/registry'
import { sizePosition } from '../risk/riskEngine'
import { effectiveSpread } from '../execution/costModel'
import type { BookCell, DecayReport, ExpectancyBook } from './expectancyBook'
import { lookupCell } from './expectancyBook'

/**
 * The setup scanner — the honest form of "tell me the best move".
 *
 * It never predicts. It runs the SAME strategy evaluation the backtester uses,
 * on the latest bar, and when a setup appears it attaches the historical record
 * of that setup in that context: expectancy, sample size, confidence, and the
 * single biggest risk to this particular instance.
 *
 * Setups below the evidence floor are shown as "insufficient evidence" — not
 * hidden (which would be dishonest) and not dressed up (which would be worse).
 */

export type ConfidenceGrade = 'A' | 'B' | 'C' | 'D' | 'INSUFFICIENT'

export interface ScenarioLeg {
  label: 'BULL' | 'BASE' | 'BEAR'
  description: string
  probability: number
  valueR: number
}

export interface Recommendation {
  id: string
  configId: string
  configName: string
  setup: string
  side: Side
  action: 'LONG' | 'SHORT' | 'WAIT'

  entry: number
  stopLoss: number
  takeProfit: number | null
  /** Size from the risk engine, with its reasoning attached. */
  qty: number
  riskAmount: number
  effectiveRiskPercent: number
  sizingReason: string

  /** What the record says about this setup in this context. */
  evidence: {
    cell: BookCell | null
    specificity: 'EXACT' | 'PARTIAL' | 'BASELINE'
    expectancyR: number
    expectancyLow: number
    expectancyHigh: number
    hitRate: number
    sampleSize: number
  }

  context: { session: Session; regime: Regime | null; atr: number | null }
  scenarios: ScenarioLeg[]
  /** Probability-weighted value across the scenarios, in R. */
  expectedValueR: number
  /** Expected value ÷ the money at risk. What the ranking actually sorts on. */
  riskAdjustedEV: number

  grade: ConfidenceGrade
  decay: DecayReport | null
  reasons: Reason[]
  biggestRisk: string
  explanation: string
}

export interface ScanContext {
  candles: Candle[]
  /** Index of the most recently CLOSED bar. */
  i: number
  ind: Indicators
  equity: number
  instrument: Instrument
  config: BacktestConfig
  book: ExpectancyBook
  decay: DecayReport | null
  /** Minutes until the next scheduled high-impact event, if known. */
  minutesToNextEvent: number | null
}

export function scanSetups(
  configs: StrategyConfig[],
  ctx: ScanContext,
): Recommendation[] {
  const out: Recommendation[] = []

  for (const rawConfig of configs) {
    const cfg = hydrateConfig(rawConfig)
    const strategy = getStrategy(cfg.strategyId)

    const decision = strategy.evaluate({
      i: ctx.i,
      candle: ctx.candles[ctx.i],
      candles: ctx.candles,
      ind: ctx.ind,
      positions: [],
      position: null,
      pendingOrders: [],
      equity: ctx.equity,
      params: cfg.params,
      instrument: ctx.instrument,
    })

    const places = decision.intents.filter(
      (x): x is Extract<Intent, { kind: 'PLACE' }> => x.kind === 'PLACE',
    )

    if (!places.length) continue

    for (const place of places) {
      out.push(buildRecommendation(place, decision.reasons, cfg, ctx))
    }
  }

  return rankRecommendations(out)
}

function buildRecommendation(
  place: Extract<Intent, { kind: 'PLACE' }>,
  reasons: Reason[],
  cfg: StrategyConfig,
  ctx: ScanContext,
): Recommendation {
  const session = ctx.ind.session[ctx.i]
  const regime = ctx.ind.regime[ctx.i]
  const atr = ctx.ind.atr[ctx.i]

  const sizing = sizePosition({
    equity: ctx.equity,
    entryPrice: place.price,
    stopLoss: place.stopLoss,
    side: place.side,
    instrument: ctx.instrument,
    risk: ctx.config.risk,
    atr,
  })

  const { cell, specificity } = lookupCell(
    ctx.book,
    place.tag,
    session,
    regime ?? { vol: 'MID_VOL', trend: 'RANGING' },
    place.side,
  )

  const rDistance = Math.abs(place.price - place.stopLoss)
  const targetR =
    place.takeProfit !== null && rDistance > 0
      ? Math.abs(place.takeProfit - place.price) / rDistance
      : 1

  const scenarios = buildScenarios(cell, targetR)
  const expectedValueR = scenarios.reduce((a, s) => a + s.probability * s.valueR, 0)
  const grade = gradeConfidence(cell, ctx.decay)

  const biggestRisk = identifyBiggestRisk(place, ctx, cell, atr)

  const rec: Recommendation = {
    id: `${cfg.id}:${place.tag}:${ctx.i}`,
    configId: cfg.id,
    configName: cfg.name,
    setup: place.tag,
    side: place.side,
    action: sizing.ok ? place.side : 'WAIT',
    entry: place.price,
    stopLoss: place.stopLoss,
    takeProfit: place.takeProfit,
    qty: sizing.qty,
    riskAmount: sizing.riskAmount,
    effectiveRiskPercent: sizing.effectiveRiskPercent,
    sizingReason: sizing.ok
      ? `Size ${formatQty(sizing.qty)} because a ${rDistance.toFixed(4)} stop at this ATR risks ${sizing.riskAmount.toFixed(2)}, exactly ${sizing.effectiveRiskPercent.toFixed(2)}% of equity.`
      : sizing.reason,
    evidence: {
      cell,
      specificity,
      expectancyR: cell?.expectancyR.point ?? 0,
      expectancyLow: cell?.expectancyR.low ?? 0,
      expectancyHigh: cell?.expectancyR.high ?? 0,
      hitRate: cell?.hitRate.point ?? 0,
      sampleSize: cell?.n ?? 0,
    },
    context: { session, regime, atr },
    scenarios,
    expectedValueR,
    riskAdjustedEV: grade === 'INSUFFICIENT' ? -Infinity : expectedValueR,
    grade,
    decay: ctx.decay,
    reasons,
    biggestRisk,
    explanation: '',
  }

  rec.explanation = explain(rec)
  return rec
}

/**
 * Bull / base / bear, built from the measured hit rate and MFE rather than
 * from anyone's opinion about where the market is going.
 */
function buildScenarios(cell: BookCell | null, targetR: number): ScenarioLeg[] {
  if (!cell || cell.n === 0) {
    return [
      { label: 'BULL', description: 'Target reached.', probability: 0, valueR: targetR },
      { label: 'BASE', description: 'No historical record for this setup.', probability: 1, valueR: 0 },
      { label: 'BEAR', description: 'Stopped out.', probability: 0, valueR: -1 },
    ]
  }

  const hit = cell.hitRate.point
  // Trades that neither hit target nor stop cleanly — timeouts and partials.
  const cleanLoss = Math.max(0, 1 - hit)
  const runnerShare = Math.min(0.25, Math.max(0, cell.avgMfeR - targetR) / Math.max(1, targetR))

  const pBull = hit * runnerShare
  const pBase = hit * (1 - runnerShare)
  const pBear = cleanLoss

  const norm = pBull + pBase + pBear || 1

  return [
    {
      label: 'BULL',
      description: `Runs past the target — historically this setup reached ${cell.avgMfeR.toFixed(2)}R on average before turning.`,
      probability: pBull / norm,
      valueR: Math.max(targetR, cell.avgMfeR),
    },
    {
      label: 'BASE',
      description: `Target hit as planned (${(hit * 100).toFixed(0)}% of ${cell.n} historical instances).`,
      probability: pBase / norm,
      valueR: targetR,
    },
    {
      label: 'BEAR',
      description: `Stopped out. Historically this setup went ${cell.avgMaeR.toFixed(2)}R against before resolving either way.`,
      probability: pBear / norm,
      valueR: cell.avgLossR < 0 ? cell.avgLossR : -1,
    },
  ]
}

/**
 * Confidence grade = sample size × out-of-sample honesty × decay status.
 * Deliberately never expressed as a probability of profit, because that number
 * does not exist.
 */
function gradeConfidence(cell: BookCell | null, decay: DecayReport | null): ConfidenceGrade {
  if (!cell || !cell.adequate) return 'INSUFFICIENT'
  if (cell.expectancyR.low <= 0) return 'D'

  let score = 0
  if (cell.n >= 200) score += 2
  else if (cell.n >= 100) score += 1

  if (cell.expectancyR.low > 0.1) score += 2
  else if (cell.expectancyR.low > 0.02) score += 1

  if (decay) {
    if (decay.status === 'HOLDING') score += 1
    else if (decay.status === 'DYING') score -= 2
    else if (decay.status === 'DRIFTING' || decay.status === 'SUSPICIOUSLY_GOOD') score -= 1
  }

  if (score >= 4) return 'A'
  if (score >= 2) return 'B'
  if (score >= 1) return 'C'
  return 'D'
}

function identifyBiggestRisk(
  place: Extract<Intent, { kind: 'PLACE' }>,
  ctx: ScanContext,
  cell: BookCell | null,
  atr: number | null,
): string {
  const session = ctx.ind.session[ctx.i]
  const spread = effectiveSpread(ctx.config.costs, { atr, session })
  const rDistance = Math.abs(place.price - place.stopLoss)

  if (ctx.minutesToNextEvent !== null && ctx.minutesToNextEvent <= 60) {
    return `A scheduled high-impact event lands in ${ctx.minutesToNextEvent} minutes. Spreads widen and stops become suggestions across that print.`
  }
  if (rDistance > 0 && spread / rDistance > 0.15) {
    return `The spread here is ${((spread / rDistance) * 100).toFixed(0)}% of the stop distance. Costs alone will eat most of a small edge on this setup.`
  }
  if (cell && cell.avgMaeR > 0.7) {
    return `Historically this setup goes ${cell.avgMaeR.toFixed(2)}R against before it works. Expect to sit through that, and do not widen the stop when you do.`
  }
  if (ctx.decay?.status === 'DYING') {
    return 'The recent record for this setup has broken down against its baseline. The historical numbers below describe a market that may no longer exist.'
  }
  if (!cell || !cell.adequate) {
    return `Only ${cell?.n ?? 0} historical instances. The expectancy shown is barely distinguishable from noise.`
  }
  if (session === 'OFF' || session === 'ASIA') {
    return `${session} liquidity is thin. Fills are worse than the model assumes and the level can be swept without follow-through.`
  }
  return 'The measured edge is small relative to its own confidence interval. Size accordingly and do not add to it.'
}

function explain(rec: Recommendation): string {
  const parts: string[] = []
  const cell = rec.evidence.cell

  if (rec.grade === 'INSUFFICIENT') {
    parts.push(
      `${rec.setup} triggered ${rec.side.toLowerCase()}, but there is not enough history behind it to say anything. ${rec.evidence.sampleSize} prior instances.`,
    )
  } else if (cell) {
    parts.push(
      `${rec.setup} triggered ${rec.side.toLowerCase()} in the ${rec.context.session} session. Historically this setup reached its target before its stop ${(rec.evidence.hitRate * 100).toFixed(0)}% of the time across ${rec.evidence.sampleSize} instances, for ${rec.evidence.expectancyR.toFixed(3)}R per trade (95% CI ${fmt(rec.evidence.expectancyLow)} to ${fmt(rec.evidence.expectancyHigh)}).`,
    )
    if (rec.evidence.specificity === 'PARTIAL') {
      parts.push(
        'No cell had enough trades for this exact session and regime, so the figures come from the setup as a whole. The context may matter more than this suggests.',
      )
    } else if (rec.evidence.specificity === 'BASELINE') {
      parts.push(
        'No record for this setup at all — the numbers shown are the unconditional baseline across every trade.',
      )
    }
  }

  if (rec.action === 'WAIT') {
    parts.push(`Not actionable: ${rec.sizingReason}`)
  } else {
    parts.push(rec.sizingReason)
  }

  parts.push(`Biggest risk: ${rec.biggestRisk}`)

  if (rec.decay && rec.decay.status !== 'HOLDING' && rec.decay.status !== 'UNKNOWN') {
    parts.push(rec.decay.message)
  }

  return parts.join(' ')
}

const fmt = (x: number): string =>
  Number.isFinite(x) ? x.toFixed(3) : x > 0 ? '+∞' : '−∞'

const formatQty = (q: number): string =>
  q >= 1 ? q.toFixed(2) : q.toPrecision(3)

/**
 * Rank by risk-adjusted expected value. Setups with insufficient evidence sort
 * to the bottom regardless of how good their raw numbers look — which is exactly
 * the case where raw numbers look best.
 */
export function rankRecommendations(recs: Recommendation[]): Recommendation[] {
  return [...recs].sort((a, b) => {
    const aInsufficient = a.grade === 'INSUFFICIENT'
    const bInsufficient = b.grade === 'INSUFFICIENT'
    if (aInsufficient !== bInsufficient) return aInsufficient ? 1 : -1
    if (a.action === 'WAIT' && b.action !== 'WAIT') return 1
    if (b.action === 'WAIT' && a.action !== 'WAIT') return -1
    return b.riskAdjustedEV - a.riskAdjustedEV
  })
}

/** Side-by-side comparison of two candidates, with the reasoning stated. */
export interface Comparison {
  winner: Recommendation | null
  reasons: string[]
  verdict: string
}

export function compareRecommendations(
  a: Recommendation,
  b: Recommendation,
): Comparison {
  const reasons: string[] = []

  const evGap = a.expectedValueR - b.expectedValueR
  reasons.push(
    `Expected value: ${a.setup} ${a.expectedValueR.toFixed(3)}R vs ${b.setup} ${b.expectedValueR.toFixed(3)}R (${evGap >= 0 ? '+' : ''}${evGap.toFixed(3)}R).`,
  )
  reasons.push(
    `Evidence: ${a.evidence.sampleSize} instances behind ${a.setup}, ${b.evidence.sampleSize} behind ${b.setup}.`,
  )
  reasons.push(`Confidence grade: ${a.grade} vs ${b.grade}.`)

  if (a.grade === 'INSUFFICIENT' && b.grade !== 'INSUFFICIENT') {
    return {
      winner: b,
      reasons,
      verdict: `${b.setup}, because ${a.setup} has no usable record. A better-looking number on ${a.evidence.sampleSize} samples is not a better trade.`,
    }
  }
  if (b.grade === 'INSUFFICIENT' && a.grade !== 'INSUFFICIENT') {
    return {
      winner: a,
      reasons,
      verdict: `${a.setup}, because ${b.setup} has no usable record.`,
    }
  }

  // Compare on the LOWER confidence bound — what can be defended, not what was
  // observed at its most flattering.
  const aFloor = a.evidence.expectancyLow
  const bFloor = b.evidence.expectancyLow
  const winner = aFloor >= bFloor ? a : b
  const loser = winner === a ? b : a

  return {
    winner,
    reasons,
    verdict: `${winner.setup}. Judged on the lower bound of the confidence interval (${fmt(winner.evidence.expectancyLow)}R vs ${fmt(loser.evidence.expectancyLow)}R) rather than the point estimate, because the point estimate is the part most likely to be luck.`,
  }
}
