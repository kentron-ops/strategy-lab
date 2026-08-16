import type { Regime, Session, Side } from '../types'

/**
 * The journal.
 *
 * A journal that only records what you tell it is a diary — it inherits every
 * error and every flattering memory you bring to it. What makes this one worth
 * trusting is that it checks your entries against the market's own record
 * (see reconcile.ts) and names the behaviours that cost you money, in your own
 * numbers.
 */

export interface JournalEntry {
  id: string
  symbol: string
  side: Side
  qty: number

  entryTime: number
  entryPrice: number
  exitTime: number
  exitPrice: number

  /** Without a stop there is no R, and without R nothing is comparable. */
  stopLoss: number | null
  takeProfit: number | null

  /** Costs as reported by the broker, in account currency. */
  fees: number

  /** What the plan SAID to do, when it differs from what happened. */
  plannedEntry: number | null
  plannedStop: number | null
  plannedRiskPercent: number | null

  setupTag: string
  notes: string
  /** Which strategy config this trade was supposed to be following. */
  strategyConfigId: string | null

  /** Manually asserted by the trader; the engine adds its own on top. */
  manualTags: BehaviorTag[]

  createdAt: number
  source: 'manual' | 'csv' | 'broker'
}

export type BehaviorTag =
  | 'NO_STOP'
  | 'MOVED_STOP'
  | 'OVERSIZED'
  | 'OVERTRADING'
  | 'REVENGE_TRADE'
  | 'OUTSIDE_PLAN_HOURS'
  | 'CUT_WINNER_EARLY'
  | 'HELD_LOSER_LONG'
  | 'TRADED_AFTER_DAILY_LOSS'
  | 'DEVIATED_FROM_PLAN'

export const BEHAVIOR_TAG_INFO: Record<
  BehaviorTag,
  { label: string; why: string }
> = {
  NO_STOP: {
    label: 'No stop recorded',
    why: 'Without a stop the trade has no defined risk, so it cannot be sized, compared, or measured in R. It is also the single fastest route to a career-ending loss.',
  },
  MOVED_STOP: {
    label: 'Stop appears to have moved',
    why: 'The exit sits beyond the stop you logged, in the losing direction. Either the stop was widened mid-trade or the log is wrong — both are worth knowing.',
  },
  OVERSIZED: {
    label: 'Larger than the plan allowed',
    why: 'Risk exceeded the percentage you set when you were calm. Position size is the one variable that turns a normal losing streak into ruin.',
  },
  OVERTRADING: {
    label: 'Unusually busy day',
    why: 'Well above your own median trade count for a day. Frequency rarely rises because opportunity rose.',
  },
  REVENGE_TRADE: {
    label: 'Entered quickly after a loss',
    why: 'Opened within minutes of closing a loser. This is the most expensive documented pattern in retail trading.',
  },
  OUTSIDE_PLAN_HOURS: {
    label: 'Outside planned hours',
    why: 'Traded in a session your plan excludes. Spreads and behaviour differ by session, and edges measured in one rarely transfer.',
  },
  CUT_WINNER_EARLY: {
    label: 'Winner cut well before its target',
    why: 'Closed far short of the target while in profit. Comfortable in the moment, and the main reason a positive-expectancy system produces a flat account.',
  },
  HELD_LOSER_LONG: {
    label: 'Loser held far longer than winners',
    why: 'Held a loss much longer than your average winner. Hoping is not a stop.',
  },
  TRADED_AFTER_DAILY_LOSS: {
    label: 'Traded past the daily loss limit',
    why: 'Kept trading after the day was already down more than your rule allows. The rule exists precisely for the state of mind you are in at that moment.',
  },
  DEVIATED_FROM_PLAN: {
    label: 'Entry differed from the plan',
    why: 'The fill is far from the planned entry. Chasing changes the geometry of the trade and quietly worsens its expectancy.',
  },
}

/** A journal entry enriched with everything the engine can derive or verify. */
export interface EnrichedEntry extends JournalEntry {
  netPnl: number
  grossPnl: number
  rDistance: number | null
  riskAmount: number | null
  r: number | null
  barsHeld: number | null
  holdingMs: number
  session: Session
  regime: Regime | null
  dayKey: string
  /** MFE/MAE measured from real market data, when available. */
  mfeR: number | null
  maeR: number | null
  tags: BehaviorTag[]
  reconciliation: ReconciliationResult | null
}

export type ReconciliationVerdict =
  | 'VERIFIED'
  | 'IMPLAUSIBLE'
  | 'NO_DATA'
  | 'OUT_OF_RANGE'
  | 'PARTIAL'

export interface ReconciliationIssue {
  code:
    | 'ENTRY_PRICE_IMPOSSIBLE'
    | 'EXIT_PRICE_IMPOSSIBLE'
    | 'ENTRY_TIME_MISSING'
    | 'EXIT_TIME_MISSING'
    | 'EXIT_BEFORE_ENTRY'
    | 'STOP_NEVER_TOUCHED_BUT_STOPPED'
    | 'SYMBOL_MISMATCH'
  message: string
  /** How far outside the bar the logged price sat, in price units. */
  distance?: number
}

export interface ReconciliationResult {
  verdict: ReconciliationVerdict
  issues: ReconciliationIssue[]
  entryBar: number | null
  exitBar: number | null
  /** The market's actual extremes over the holding period. */
  actualHigh: number | null
  actualLow: number | null
  checkedAgainst: string
}
