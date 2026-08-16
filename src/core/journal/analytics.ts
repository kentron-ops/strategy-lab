import type { Dataset, Instrument, Metrics, Trade } from '../types'
import { DEFAULT_INDICATORS, DEFAULT_INSTRUMENT, TF_MS } from '../types'
import type { EnrichedEntry, JournalEntry } from './types'
import {
  DEFAULT_BEHAVIOR,
  costOfBehaviors,
  tagBehaviors,
  type BehaviorConfig,
  type TagCost,
} from './behaviorTags'
import { measureExcursions, reconcileEntry, DEFAULT_RECONCILE } from './reconcile'
import { computeMetrics, sliceBy, type Slice } from '../backtest/metrics'
import { sessionOf, utcDayKey, utcDayOfWeek, DAY_NAMES } from '../util/time'
import { mean } from '../util/stats'

/**
 * Journal analytics.
 *
 * Deliberately computed with the SAME functions as the backtester
 * (`computeMetrics`, `sliceBy`). That is the whole point: unless reality and
 * simulation are measured identically, comparing them proves nothing.
 */

export interface EnrichOptions {
  reference: Dataset | null
  instrument: Instrument
  behavior: BehaviorConfig
  startingEquity: number
}

export const DEFAULT_ENRICH: EnrichOptions = {
  reference: null,
  instrument: DEFAULT_INSTRUMENT,
  behavior: DEFAULT_BEHAVIOR,
  startingEquity: 0,
}

export function enrichEntries(
  entries: JournalEntry[],
  opts: EnrichOptions = DEFAULT_ENRICH,
): EnrichedEntry[] {
  const barMs = opts.reference ? TF_MS[opts.reference.timeframe] : 0

  const base: EnrichedEntry[] = entries.map((e) => {
    const direction = e.side === 'LONG' ? 1 : -1
    const grossPnl =
      (e.exitPrice - e.entryPrice) * direction * e.qty * opts.instrument.pointValue
    const netPnl = grossPnl - e.fees

    const rDistance = e.stopLoss !== null ? Math.abs(e.entryPrice - e.stopLoss) : null
    const riskAmount =
      rDistance !== null && rDistance > 0
        ? rDistance * e.qty * opts.instrument.pointValue
        : null

    const excursions =
      opts.reference && barMs
        ? measureExcursions(e, opts.reference, barMs)
        : { mfeR: null, maeR: null, barsHeld: null }

    return {
      ...e,
      grossPnl,
      netPnl,
      rDistance,
      riskAmount,
      r: riskAmount && riskAmount > 0 ? netPnl / riskAmount : null,
      barsHeld: excursions.barsHeld,
      holdingMs: Math.max(0, e.exitTime - e.entryTime),
      session: sessionOf(e.entryTime, DEFAULT_INDICATORS.sessionBoundsUtc),
      regime: null,
      dayKey: utcDayKey(e.entryTime),
      mfeR: excursions.mfeR,
      maeR: excursions.maeR,
      tags: [...e.manualTags],
      reconciliation:
        opts.reference && barMs
          ? reconcileEntry(e, opts.reference, barMs, DEFAULT_RECONCILE)
          : null,
    }
  })

  const tagMap = tagBehaviors(base, opts.behavior, opts.startingEquity)
  for (const e of base) e.tags = tagMap.get(e.id) ?? e.tags

  return base.sort((a, b) => a.entryTime - b.entryTime)
}

/** Convert to the engine's Trade shape so the same metrics code applies. */
export function entriesAsTrades(entries: EnrichedEntry[]): Trade[] {
  return entries.map((e, i) => ({
    id: e.id,
    strategyId: e.strategyConfigId ?? 'journal',
    side: e.side,
    qty: e.qty,
    tag: e.setupTag,
    entryBar: i,
    entryTime: e.entryTime,
    entryPrice: e.entryPrice,
    exitBar: i,
    exitTime: e.exitTime,
    exitPrice: e.exitPrice,
    stopLoss: e.stopLoss ?? e.entryPrice,
    takeProfit: e.takeProfit,
    rDistance: e.rDistance ?? 0,
    riskAmount: e.riskAmount ?? 0,
    exitReason: e.netPnl >= 0 ? 'TARGET' : 'STOP',
    grossPnl: e.grossPnl,
    costs: e.fees,
    netPnl: e.netPnl,
    r: e.r ?? 0,
    mfeR: e.mfeR ?? 0,
    maeR: e.maeR ?? 0,
    barsHeld: e.barsHeld ?? 0,
    holdingMs: e.holdingMs,
    ambiguous: false,
    excluded: false,
    session: e.session,
    regime: e.regime ?? { vol: 'MID_VOL', trend: 'RANGING' },
    equityAfter: 0,
    reasons: [],
  }))
}

export interface JournalAnalytics {
  metrics: Metrics
  bySession: Slice[]
  byDayOfWeek: Slice[]
  bySetup: Slice[]
  byTag: Slice[]
  behaviorCosts: TagCost[]
  reconciliation: {
    verified: number
    implausible: number
    partial: number
    noData: number
    /** Trades whose logged prices could not have happened. */
    flagged: EnrichedEntry[]
  }
  excursions: {
    avgMfeR: number | null
    avgMaeR: number | null
    /** Average R left on the table across winners. */
    leftOnTableR: number | null
  }
  warnings: string[]
}

export function analyseJournal(
  entries: EnrichedEntry[],
  startingEquity: number,
): JournalAnalytics {
  const warnings: string[] = []
  const trades = entriesAsTrades(entries)
  const withR = entries.filter((e) => e.r !== null)

  if (entries.length && withR.length < entries.length) {
    warnings.push(
      `${entries.length - withR.length} of ${entries.length} trades have no stop recorded, so they have no R and are excluded from every R-based figure. A trade with no defined risk cannot be compared to one that has it.`,
    )
  }

  const metrics = computeMetrics(trades, [], startingEquity, {
    barsInPosition: 0,
    totalBars: 0,
  })

  const recon = {
    verified: 0,
    implausible: 0,
    partial: 0,
    noData: 0,
    flagged: [] as EnrichedEntry[],
  }
  for (const e of entries) {
    switch (e.reconciliation?.verdict) {
      case 'VERIFIED':
        recon.verified += 1
        break
      case 'IMPLAUSIBLE':
        recon.implausible += 1
        recon.flagged.push(e)
        break
      case 'PARTIAL':
        recon.partial += 1
        recon.flagged.push(e)
        break
      default:
        recon.noData += 1
    }
  }

  if (recon.implausible > 0) {
    warnings.push(
      `${recon.implausible} trade(s) log a price the market never printed at that time. Until those are corrected, every number on this page is built partly on fiction.`,
    )
  }
  if (recon.noData === entries.length && entries.length > 0) {
    warnings.push(
      'No reference market data loaded, so nothing here has been verified. Load a dataset covering these dates to check the journal against reality.',
    )
  }

  const winners = entries.filter((e) => e.netPnl > 0 && e.r !== null && e.mfeR !== null)
  const leftOnTable = winners.length
    ? mean(winners.map((e) => (e.mfeR as number) - (e.r as number)))
    : null

  const mfeValues = entries.filter((e) => e.mfeR !== null).map((e) => e.mfeR as number)
  const maeValues = entries.filter((e) => e.maeR !== null).map((e) => e.maeR as number)

  return {
    metrics,
    bySession: sliceBy(trades, (t) => t.session),
    byDayOfWeek: sliceBy(
      trades,
      (t) => String(utcDayOfWeek(t.entryTime)),
      (k) => DAY_NAMES[Number(k)] ?? k,
    ),
    bySetup: sliceBy(trades, (t) => t.tag || 'untagged'),
    byTag: sliceByTag(entries),
    behaviorCosts: costOfBehaviors(entries),
    reconciliation: recon,
    excursions: {
      avgMfeR: mfeValues.length ? mean(mfeValues) : null,
      avgMaeR: maeValues.length ? mean(maeValues) : null,
      leftOnTableR: leftOnTable,
    },
    warnings,
  }
}

function sliceByTag(entries: EnrichedEntry[]): Slice[] {
  const expanded: Trade[] = []
  const asTrades = entriesAsTrades(entries)
  entries.forEach((e, i) => {
    for (const tag of e.tags) expanded.push({ ...asTrades[i], tag })
  })
  return sliceBy(expanded, (t) => t.tag)
}

// ─────────────────────────────────────────────────────────────────────────────
// The gap: what you did vs what your own rules said
// ─────────────────────────────────────────────────────────────────────────────

export interface MechanicalGap {
  human: { trades: number; expectancyR: number; netPnl: number; winRate: number }
  mechanical: { trades: number; expectancyR: number; netPnl: number; winRate: number }
  /** mechanical − human, in R per trade. Positive = the rules beat the person. */
  gapR: number
  /** The same gap expressed in the trader's own money. */
  gapMoney: number
  verdict: string
}

/**
 * Compare the trader's realised results to the same strategy run mechanically
 * over the same period.
 *
 * This is the most defensible feedback the app can produce, because both sides
 * are measured by identical code over identical data. It is also, for most
 * people, the most uncomfortable — the machine usually wins, and it wins by not
 * being frightened.
 */
export function compareToMechanical(
  journal: Metrics,
  mechanical: Metrics,
): MechanicalGap {
  const gapR = mechanical.expectancyR.point - journal.expectancyR.point
  const gapMoney = gapR * journal.trades * avgRiskProxy(journal)

  let verdict: string
  if (journal.trades < 20) {
    verdict = `Only ${journal.trades} logged trades. The comparison is directional at best — log more before drawing conclusions from it.`
  } else if (gapR > 0.15) {
    verdict = `Run mechanically, the same rules produced ${gapR.toFixed(2)}R more per trade than you did. Over your ${journal.trades} trades that is roughly ${gapMoney.toFixed(0)} in your own money, and it was lost to execution rather than to the strategy.`
  } else if (gapR < -0.15) {
    verdict = `You beat the mechanical version by ${Math.abs(gapR).toFixed(2)}R per trade. Either your discretion is adding something real, or you are filtering trades in a way worth writing down as a rule and testing.`
  } else {
    verdict = `You and the mechanical version are within ${Math.abs(gapR).toFixed(2)}R per trade of each other. Execution is not currently your problem — the strategy itself is the constraint.`
  }

  return {
    human: {
      trades: journal.trades,
      expectancyR: journal.expectancyR.point,
      netPnl: journal.netPnl,
      winRate: journal.winRate.point,
    },
    mechanical: {
      trades: mechanical.trades,
      expectancyR: mechanical.expectancyR.point,
      netPnl: mechanical.netPnl,
      winRate: mechanical.winRate.point,
    },
    gapR,
    gapMoney,
    verdict,
  }
}

function avgRiskProxy(m: Metrics): number {
  if (!m.trades || m.expectancyR.point === 0) return 0
  return Math.abs(m.expectancy / m.expectancyR.point)
}

// ─────────────────────────────────────────────────────────────────────────────
// Suggestions — rules and statistics, never an oracle
// ─────────────────────────────────────────────────────────────────────────────

export interface Suggestion {
  title: string
  detail: string
  /** Expected effect, stated in the trader's own numbers. */
  expectedEffect: string
  sampleSize: number
  confidence: 'LOW' | 'MEDIUM' | 'HIGH'
}

export function suggestImprovements(
  analytics: JournalAnalytics,
  entries: EnrichedEntry[],
): Suggestion[] {
  const out: Suggestion[] = []
  const m = analytics.metrics
  const n = m.trades
  if (!n) return out

  const confidenceFor = (sample: number): Suggestion['confidence'] =>
    sample >= 100 ? 'HIGH' : sample >= 30 ? 'MEDIUM' : 'LOW'

  // 1. Negative expectancy with a decent win rate → the payoff is the problem.
  if (m.expectancyR.point <= 0 && m.winRate.point >= 0.4) {
    const payoff = m.avgLoss !== 0 ? Math.abs(m.avgWin / m.avgLoss) : 0
    out.push({
      title: 'Your win rate is fine; your payoff is not',
      detail: `You win ${(m.winRate.point * 100).toFixed(0)}% of the time but your average win is only ${payoff.toFixed(2)}× your average loss, so expectancy is ${m.expectancyR.point.toFixed(3)}R. Raising the win rate will not fix this — the arithmetic needs a bigger winner or a smaller loser.`,
      expectedEffect: `At this win rate you need a payoff above ${((1 - m.winRate.point) / Math.max(0.01, m.winRate.point)).toFixed(2)}× just to break even before costs.`,
      sampleSize: n,
      confidence: confidenceFor(n),
    })
  }

  // 2. Winners cut short of what the market offered.
  const left = analytics.excursions.leftOnTableR
  if (left !== null && left > 0.4) {
    out.push({
      title: 'You are leaving roughly ' + left.toFixed(2) + 'R on the table per winner',
      detail: `Across your winning trades, price ran an average of ${left.toFixed(2)}R beyond where you closed. Widening the target toward the MFE your winners actually reach is the most direct change available to you.`,
      expectedEffect: `Capturing half of that would add about ${(left * 0.5 * (m.winRate.point)).toFixed(3)}R per trade overall — around ${(left * 0.5 * m.winRate.point * n).toFixed(1)}R across your ${n} trades. It will also lower your win rate, which is fine.`,
      sampleSize: m.wins,
      confidence: confidenceFor(m.wins),
    })
  }

  // 3. Stops repeatedly clipped before the move.
  if (m.avgMaeR > 0.85 && m.winRate.point > 0.35) {
    out.push({
      title: 'Your stops sit right at the edge of normal noise',
      detail: `Winning trades still went ${m.avgMaeR.toFixed(2)}R against you before working. A stop that close is being hit by ordinary movement rather than by being wrong.`,
      expectedEffect:
        'Widening the stop requires cutting position size by the same proportion to hold risk constant. That trade is usually worth making; taking it without resizing is not.',
      sampleSize: n,
      confidence: confidenceFor(n),
    })
  }

  // 4. A session that is reliably costing money.
  const worstSession = [...analytics.bySession]
    .filter((s) => s.adequate)
    .sort((a, b) => a.expectancyR.point - b.expectancyR.point)[0]
  if (worstSession && worstSession.expectancyR.point < -0.05 && worstSession.expectancyR.high < 0) {
    out.push({
      title: `The ${worstSession.label} session is costing you money`,
      detail: `${worstSession.trades} trades there at ${worstSession.expectancyR.point.toFixed(3)}R each, and the whole confidence interval sits below zero. This is not noise.`,
      expectedEffect: `Dropping it removes ${worstSession.netPnl.toFixed(0)} of losses from your record and lifts overall expectancy by roughly ${((-worstSession.expectancyR.point * worstSession.trades) / n).toFixed(3)}R per remaining trade.`,
      sampleSize: worstSession.trades,
      confidence: confidenceFor(worstSession.trades),
    })
  }

  // 5. The most expensive behaviour.
  const worstBehavior = analytics.behaviorCosts.filter((b) => b.trades >= 5)[0]
  if (worstBehavior && worstBehavior.deltaR < -0.2) {
    out.push({
      title: `"${worstBehavior.tag.replace(/_/g, ' ').toLowerCase()}" is your most expensive habit`,
      detail: `${worstBehavior.trades} trades carry this tag and they average ${worstBehavior.avgR.toFixed(2)}R against ${worstBehavior.baselineAvgR.toFixed(2)}R for everything else.`,
      expectedEffect: `Eliminating it entirely would have been worth about ${(-worstBehavior.deltaR * worstBehavior.trades).toFixed(1)}R. This is a decision you make before the session, not during it.`,
      sampleSize: worstBehavior.trades,
      confidence: confidenceFor(worstBehavior.trades),
    })
  }

  // 6. Trades that cannot be verified.
  if (analytics.reconciliation.implausible > 0) {
    out.push({
      title: 'Some logged prices never happened',
      detail: `${analytics.reconciliation.implausible} trade(s) record a fill outside the market's range at that moment. Fix these before trusting anything above.`,
      expectedEffect:
        'No performance change — but every figure on this page is currently computed partly from prices that did not exist.',
      sampleSize: analytics.reconciliation.implausible,
      confidence: 'HIGH',
    })
  }

  if (!m.sampleAdequate) {
    out.unshift({
      title: 'There is not yet enough here to conclude much',
      detail: `${n} trades. Below ${m.sampleThreshold} the confidence intervals are wider than the effects anyone is looking for.`,
      expectedEffect: 'Keep logging. Everything below is a hint, not a finding.',
      sampleSize: n,
      confidence: 'LOW',
    })
  }

  return out
}
