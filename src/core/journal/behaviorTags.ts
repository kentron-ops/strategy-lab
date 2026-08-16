import type { BehaviorTag, EnrichedEntry, JournalEntry } from './types'
import { mean, percentile } from '../util/stats'

/**
 * Behavioural leak detection.
 *
 * The largest, most reliable drain on a retail account is not a bad indicator —
 * it is the gap between the plan and what the person actually did under
 * pressure. Every rule here compares a trade to the trader's OWN baseline, so it
 * cannot be dismissed as someone else's standard.
 */

export interface BehaviorConfig {
  /** A day is "busy" above this multiple of the trader's median daily count. */
  overtradingMultiple: number
  /** Re-entering within this many minutes of closing a loss. */
  revengeWindowMinutes: number
  /** Planned risk exceeded by this fraction counts as oversized. */
  oversizedTolerance: number
  /** Sessions the plan permits. Empty = all. */
  plannedSessions: string[]
  /** A winner closed below this fraction of its MFE was cut early. */
  cutEarlyFraction: number
  /** Daily loss limit, as a fraction of starting equity. */
  maxDailyLossPercent: number | null
  /** Entry this far from the planned entry, in R, counts as chasing. */
  chaseToleranceR: number
}

export const DEFAULT_BEHAVIOR: BehaviorConfig = {
  overtradingMultiple: 2,
  revengeWindowMinutes: 15,
  oversizedTolerance: 0.25,
  plannedSessions: [],
  cutEarlyFraction: 0.5,
  maxDailyLossPercent: null,
  chaseToleranceR: 0.5,
}

/**
 * Tag a set of entries. Takes the whole set because most of these rules are only
 * meaningful relative to the trader's own history — "unusually busy" needs a
 * baseline, and a baseline needs everything.
 */
export function tagBehaviors(
  entries: EnrichedEntry[],
  cfg: BehaviorConfig = DEFAULT_BEHAVIOR,
  startingEquity = 0,
): Map<string, BehaviorTag[]> {
  const out = new Map<string, BehaviorTag[]>()
  if (!entries.length) return out

  const sorted = [...entries].sort((a, b) => a.entryTime - b.entryTime)

  // ── baselines drawn from the trader's own record
  const perDay = new Map<string, EnrichedEntry[]>()
  for (const e of sorted) {
    const arr = perDay.get(e.dayKey)
    if (arr) arr.push(e)
    else perDay.set(e.dayKey, [e])
  }
  const dailyCounts = [...perDay.values()].map((a) => a.length)
  const medianDaily = dailyCounts.length ? percentile(dailyCounts, 0.5) : 0

  const winners = sorted.filter((e) => e.netPnl > 0)
  const avgWinnerHold = winners.length ? mean(winners.map((e) => e.holdingMs)) : 0

  // ── running day P&L, for the daily-loss rule
  const dayPnlBefore = new Map<string, number>()
  const runningDay = new Map<string, number>()
  for (const e of sorted) {
    dayPnlBefore.set(e.id, runningDay.get(e.dayKey) ?? 0)
    runningDay.set(e.dayKey, (runningDay.get(e.dayKey) ?? 0) + e.netPnl)
  }

  let previous: EnrichedEntry | null = null

  for (const e of sorted) {
    const tags: BehaviorTag[] = [...e.manualTags]
    const add = (t: BehaviorTag): void => {
      if (!tags.includes(t)) tags.push(t)
    }

    if (e.stopLoss === null) add('NO_STOP')

    // Exit beyond the logged stop, on the losing side: the stop moved, or the
    // record is wrong.
    if (e.stopLoss !== null && e.rDistance) {
      const beyond =
        e.side === 'LONG'
          ? e.exitPrice < e.stopLoss - e.rDistance * 0.15
          : e.exitPrice > e.stopLoss + e.rDistance * 0.15
      if (beyond) add('MOVED_STOP')
    }

    if (
      e.plannedRiskPercent !== null &&
      e.riskAmount !== null &&
      startingEquity > 0
    ) {
      const actualPct = (e.riskAmount / startingEquity) * 100
      if (actualPct > e.plannedRiskPercent * (1 + cfg.oversizedTolerance)) {
        add('OVERSIZED')
      }
    }

    if (medianDaily > 0) {
      const count = perDay.get(e.dayKey)?.length ?? 0
      if (count > medianDaily * cfg.overtradingMultiple) add('OVERTRADING')
    }

    if (
      previous &&
      previous.netPnl < 0 &&
      e.entryTime - previous.exitTime <= cfg.revengeWindowMinutes * 60_000 &&
      e.entryTime >= previous.exitTime
    ) {
      add('REVENGE_TRADE')
    }

    if (cfg.plannedSessions.length && !cfg.plannedSessions.includes(e.session)) {
      add('OUTSIDE_PLAN_HOURS')
    }

    if (e.netPnl > 0 && e.mfeR !== null && e.r !== null && e.mfeR > 0.5) {
      if (e.r < e.mfeR * cfg.cutEarlyFraction) add('CUT_WINNER_EARLY')
    }

    if (e.netPnl < 0 && avgWinnerHold > 0 && e.holdingMs > avgWinnerHold * 2) {
      add('HELD_LOSER_LONG')
    }

    if (cfg.maxDailyLossPercent !== null && startingEquity > 0) {
      const before = dayPnlBefore.get(e.id) ?? 0
      const limit = -(startingEquity * cfg.maxDailyLossPercent) / 100
      if (before <= limit) add('TRADED_AFTER_DAILY_LOSS')
    }

    if (e.plannedEntry !== null && e.rDistance) {
      const drift = Math.abs(e.entryPrice - e.plannedEntry) / e.rDistance
      if (drift > cfg.chaseToleranceR) add('DEVIATED_FROM_PLAN')
    }

    out.set(e.id, tags)
    previous = e
  }

  return out
}

/** Cost attribution: what each behaviour actually cost, in the trader's money. */
export interface TagCost {
  tag: BehaviorTag
  trades: number
  netPnl: number
  avgR: number
  /** Net P&L of trades WITHOUT this tag, per trade — the comparison baseline. */
  baselineAvgR: number
  /** avgR − baselineAvgR. Negative means the behaviour costs money. */
  deltaR: number
}

export function costOfBehaviors(entries: EnrichedEntry[]): TagCost[] {
  const withR = entries.filter((e) => e.r !== null)
  if (!withR.length) return []

  const tags = new Set<BehaviorTag>()
  for (const e of withR) for (const t of e.tags) tags.add(t)

  const out: TagCost[] = []
  for (const tag of tags) {
    const tagged = withR.filter((e) => e.tags.includes(tag))
    const untagged = withR.filter((e) => !e.tags.includes(tag))
    if (!tagged.length) continue
    const avgR = mean(tagged.map((e) => e.r as number))
    const baselineAvgR = untagged.length ? mean(untagged.map((e) => e.r as number)) : 0
    out.push({
      tag,
      trades: tagged.length,
      netPnl: tagged.reduce((a, e) => a + e.netPnl, 0),
      avgR,
      baselineAvgR,
      deltaR: avgR - baselineAvgR,
    })
  }

  return out.sort((a, b) => a.deltaR - b.deltaR)
}
