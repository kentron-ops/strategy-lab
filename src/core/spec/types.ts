import type { CostConfig, RiskConfig, Session, Timeframe } from '../types'

/**
 * StrategySpec — the Strategy Compiler's data model (Build Spec V2 §3).
 *
 * A strategy is DATA, not code: typed blocks assembled into a serializable JSON
 * document that the existing deterministic engine runs. Everything here must
 * survive JSON.stringify/parse unchanged, because specs cross worker boundaries
 * today and a network boundary later.
 */

export const SPEC_VERSION = 1

// ─────────────────────────────────────────────────────────────────────────────
// Operands — the things a rule compares
// ─────────────────────────────────────────────────────────────────────────────

export type Operand =
  | { type: 'price'; field: 'open' | 'high' | 'low' | 'close' }
  | { type: 'prevPrice'; field: 'open' | 'high' | 'low' | 'close' }
  | { type: 'ema'; period: number }
  | { type: 'sma'; period: number }
  | { type: 'rsi'; period: number }
  | { type: 'atr'; period: number }
  | { type: 'adx'; period: number }
  | { type: 'rollingHigh'; period: number }
  | { type: 'rollingLow'; period: number }
  | { type: 'atrPercentile' }
  | { type: 'rangeExpansion' }
  | { type: 'bodyRatio' }
  | { type: 'value'; value: number }
  /** base ± ATR(period) × multiple — "an offset in ATR" price ref. */
  | { type: 'atrOffset'; base: Operand; multiple: number; atrPeriod: number }

export type Comparator =
  | 'GT'
  | 'GTE'
  | 'LT'
  | 'LTE'
  | 'CROSS_ABOVE'
  | 'CROSS_BELOW'
  | 'WITHIN'

export interface Condition {
  kind: 'condition'
  left: Operand
  cmp: Comparator
  right: Operand
  /** WITHIN only: |left − right| ≤ tolerance (price units). */
  tolerance?: number
}

export interface RuleGroup {
  kind: 'group'
  op: 'AND' | 'OR'
  rules: RuleNode[]
}

export type RuleNode = Condition | RuleGroup

// ─────────────────────────────────────────────────────────────────────────────
// Entry / exit / filters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How entries are placed once the entry rules pass:
 *  - MARKET: market order on the next bar.
 *  - BREAKOUT_OCO: stop orders around the recent range (both sides when
 *    direction is "both", one side otherwise), first fill cancels the sibling.
 *  - CADENCE: enter every N bars regardless of rules (baseline strategies).
 */
export type EntryMode =
  | { mode: 'MARKET' }
  | { mode: 'BREAKOUT_OCO'; lookback: number; bufferAtrMultiple: number; orderExpiryBars: number }
  | { mode: 'CADENCE'; intervalBars: number; simultaneousBothSides: boolean }

export type Direction = 'long' | 'short' | 'both'

export interface ExitSpec {
  stop: { unit: 'ATR' | 'PRICE'; value: number; atrPeriod?: number }
  target: { unit: 'R' | 'ATR' | 'PRICE'; value: number } | null
  timeoutBars: number | null
}

export type FilterNode =
  | { kind: 'session'; sessions: Session[] }
  | { kind: 'htfAlignment'; enabled: boolean }
  | Condition
  | RuleGroup

export interface StrategySpec {
  id: string
  name: string
  market: string
  timeframe: Timeframe
  direction: Direction
  entryMode: EntryMode
  /** Rules gating a LONG entry. */
  entry: RuleGroup
  /** Rules gating a SHORT entry. Null = mirror of entry semantics (mode-dependent). */
  entryShort: RuleGroup | null
  exit: ExitSpec
  filters: FilterNode[]
  risk: Pick<
    RiskConfig,
    'startingEquity' | 'riskPercent' | 'maxDailyLossPercent' | 'maxConcurrentPositions' | 'sizingMethod'
  >
  costs: Pick<CostConfig, 'spread' | 'commissionPerUnit' | 'slippage'>
  meta: {
    createdFrom: string
    specVersion: number
    createdAt: number
    notes: string
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AcceptIf — pre-registered acceptance thresholds (V2 §5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set BEFORE testing. The Prover holds the line and flags any change, because
 * moving the goalposts after seeing the result is the oldest self-deception in
 * the book.
 */
export interface AcceptIf {
  minTrades: number
  minExpectancyR: number
  registeredAt: number
  /** Bumped every time the thresholds change; the Prover reports it. */
  revisions: number
}

export const DEFAULT_ACCEPT_IF: Omit<AcceptIf, 'registeredAt'> = {
  minTrades: 30,
  minExpectancyR: 0.05,
  revisions: 0,
}

export interface SpecIssue {
  path: string
  severity: 'ERROR' | 'WARNING'
  message: string
}

/** Operand pretty-printer for reasons and the show-the-math UI. */
export function operandLabel(o: Operand): string {
  switch (o.type) {
    case 'price':
      return o.field
    case 'prevPrice':
      return `prev ${o.field}`
    case 'ema':
      return `EMA(${o.period})`
    case 'sma':
      return `SMA(${o.period})`
    case 'rsi':
      return `RSI(${o.period})`
    case 'atr':
      return `ATR(${o.period})`
    case 'adx':
      return `ADX(${o.period})`
    case 'rollingHigh':
      return `High(${o.period})`
    case 'rollingLow':
      return `Low(${o.period})`
    case 'atrPercentile':
      return 'ATR percentile'
    case 'rangeExpansion':
      return 'range expansion'
    case 'bodyRatio':
      return 'body ratio'
    case 'value':
      return String(o.value)
    case 'atrOffset':
      return `${operandLabel(o.base)} ${o.multiple >= 0 ? '+' : '−'} ${Math.abs(o.multiple)}×ATR(${o.atrPeriod})`
  }
}

export const CMP_LABEL: Record<Comparator, string> = {
  GT: '>',
  GTE: '≥',
  LT: '<',
  LTE: '≤',
  CROSS_ABOVE: 'crosses above',
  CROSS_BELOW: 'crosses below',
  WITHIN: 'is within',
}
