/**
 * Strategy Lab — core type spine.
 *
 * This file (and everything else under src/core) is pure TypeScript:
 * no React, no DOM, no browser globals. It must run in a Web Worker and in a
 * plain Node unit test. Nothing here may import from ../ui or ../state.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Market data
// ─────────────────────────────────────────────────────────────────────────────

/** One OHLC(V) bar. `t` is the bar's OPEN time, epoch milliseconds, UTC. */
export interface Candle {
  t: number
  o: number
  h: number
  l: number
  c: number
  v?: number
}

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d'

export const TF_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
}

export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']

/**
 * A loaded, validated dataset. `hash` is content-derived so any result can be
 * traced back to the exact bytes it was computed from (§13 provenance).
 */
export interface Dataset {
  id: string
  symbol: string
  timeframe: Timeframe
  candles: Candle[]
  /** How the source timestamps were interpreted. Recorded, never guessed silently. */
  timezone: string
  source: string
  hash: string
  createdAt: number
  quality?: DataQualityReport
}

export type DataIssueSeverity = 'ERROR' | 'WARNING' | 'INFO'

export interface DataIssue {
  code:
    | 'BAD_OHLC'
    | 'DUPLICATE_TIMESTAMP'
    | 'GAP'
    | 'NON_POSITIVE_PRICE'
    | 'FROZEN_CANDLE'
    | 'OUT_OF_ORDER'
    | 'IRREGULAR_SPACING'
    | 'WEEKEND_GAP'
  severity: DataIssueSeverity
  message: string
  /** Bar indices involved (capped — see `count` for the true total). */
  indices: number[]
  count: number
}

export interface DataQualityReport {
  rows: number
  from: number
  to: number
  inferredTimeframe: Timeframe | null
  issues: DataIssue[]
  /** No ERROR-severity issues. */
  usable: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Context: session & regime (most edges are conditional — §13)
// ─────────────────────────────────────────────────────────────────────────────

export type Session = 'ASIA' | 'LONDON' | 'NY' | 'OFF'
export const SESSIONS: Session[] = ['ASIA', 'LONDON', 'NY', 'OFF']

export type VolRegime = 'LOW_VOL' | 'MID_VOL' | 'HIGH_VOL'
export type TrendRegime = 'TRENDING' | 'RANGING'

export interface Regime {
  vol: VolRegime
  trend: TrendRegime
}

export const regimeKey = (r: Regime): string => `${r.vol}/${r.trend}`

// ─────────────────────────────────────────────────────────────────────────────
// Instrument & costs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Broker economics are OPTIONAL by design (§7). The default instrument is
 * normalized: pointValue 1, continuous qty. Results then live in R-space and
 * are broker-agnostic. Never invent broker-specific numbers.
 */
export interface Instrument {
  symbol: string
  /** Account currency per 1.0 of price movement per 1.0 of quantity. */
  pointValue: number
  /** 0 = continuous (no rounding). */
  qtyStep: number
  minQty: number
  maxQty: number
  priceDecimals: number
}

export const DEFAULT_INSTRUMENT: Instrument = {
  symbol: 'XAUUSD',
  pointValue: 1,
  qtyStep: 0,
  minQty: 0,
  maxQty: Number.POSITIVE_INFINITY,
  priceDecimals: 2,
}

export type SpreadMode = 'FIXED' | 'ATR_SCALED'
export type SlippageMode = 'FIXED' | 'ATR_SCALED'

export interface CostConfig {
  /** Full spread in PRICE units. Half is paid on each side of a round trip. */
  spread: number
  spreadMode: SpreadMode
  /** When ATR_SCALED: spread = atr * this. */
  spreadAtrMultiple: number
  /** Gold widens at the open and on news — time-varying, not constant (§13). */
  sessionSpreadMultiplier: Record<Session, number>
  /** Account currency per unit of qty, per side. */
  commissionPerUnit: number
  /** Adverse price movement on fill, in PRICE units. */
  slippage: number
  slippageMode: SlippageMode
  slippageAtrMultiple: number
  /** Per bar, per unit of qty. Signed cost (positive = charged). */
  financingPerBarPerUnit: number
}

export const DEFAULT_COSTS: CostConfig = {
  spread: 0.3,
  spreadMode: 'FIXED',
  spreadAtrMultiple: 0.05,
  sessionSpreadMultiplier: { ASIA: 1.3, LONDON: 1.0, NY: 1.0, OFF: 2.0 },
  commissionPerUnit: 0,
  slippage: 0.05,
  slippageMode: 'FIXED',
  slippageAtrMultiple: 0.02,
  financingPerBarPerUnit: 0,
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk
// ─────────────────────────────────────────────────────────────────────────────

export type SizingMethod =
  | 'FIXED_FRACTIONAL'
  | 'FIXED_CASH'
  | 'VOLATILITY_NORMALIZED'
  | 'FRACTIONAL_KELLY'

export interface RiskConfig {
  startingEquity: number
  /** Percent of current equity risked per trade (fixed fractional). */
  riskPercent: number
  sizingMethod: SizingMethod
  /** FIXED_CASH: risk exactly this much per trade. */
  fixedCash: number
  /** VOLATILITY_NORMALIZED: target risk = riskPercent, stop assumed = atr * this. */
  volTargetAtrMultiple: number
  /** FRACTIONAL_KELLY: fraction of full Kelly. Loud warning in UI. */
  kellyFraction: number
  /** Hard limits — always on. */
  maxConcurrentPositions: number
  maxDailyLossPercent: number | null
  maxConsecutiveLosses: number | null
  /** Kill switch: stop trading if equity falls below this % of starting equity. */
  equityFloorPercent: number | null
}

export const DEFAULT_RISK: RiskConfig = {
  startingEquity: 200,
  riskPercent: 1,
  sizingMethod: 'FIXED_FRACTIONAL',
  fixedCash: 2,
  volTargetAtrMultiple: 1.5,
  kellyFraction: 0.25,
  maxConcurrentPositions: 1,
  maxDailyLossPercent: null,
  maxConsecutiveLosses: null,
  equityFloorPercent: 30,
}

export interface SizingResult {
  qty: number
  /** Money the position risks if the stop fills exactly. */
  riskAmount: number
  /** riskAmount as % of equity at the time of sizing. */
  effectiveRiskPercent: number
  /** Distance from entry to stop, in price units. This is 1R. */
  rDistance: number
  ok: boolean
  reason: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Orders, positions, trades
// ─────────────────────────────────────────────────────────────────────────────

export type Side = 'LONG' | 'SHORT'

export type OrderType = 'MARKET' | 'STOP' | 'LIMIT'

export type OrderStatus =
  | 'PENDING'
  | 'FILLED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REJECTED'

export interface Order {
  id: string
  side: Side
  type: OrderType
  /** Trigger price for STOP/LIMIT; ignored for MARKET. */
  price: number
  /** Protective stop attached to the resulting position. Required. */
  stopLoss: number
  takeProfit: number | null
  /** Close the position after this many bars held. */
  timeoutBars: number | null
  /** Orders sharing a group cancel each other on fill (OCO). */
  ocoGroup: string | null
  /** Bar index the order was created on. Eligible from createdBar + 1. */
  createdBar: number
  /** Cancel the order if unfilled after this many bars. */
  expiresAfterBars: number | null
  status: OrderStatus
  filledBar: number | null
  filledPrice: number | null
  qty: number
  tag: string
  reasons: Reason[]
}

export interface Position {
  id: string
  orderId: string
  side: Side
  qty: number
  entryBar: number
  entryTime: number
  entryPrice: number
  stopLoss: number
  takeProfit: number | null
  timeoutBars: number | null
  /** |entry - stop| in price units at open. Frozen: 1R never re-bases. */
  rDistance: number
  /** Money at risk at open. */
  riskAmount: number
  /** Running extremes, in R. */
  mfeR: number
  maeR: number
  entryCosts: number
  financingAccrued: number
  session: Session
  regime: Regime
  tag: string
  reasons: Reason[]
}

export type ExitReason =
  | 'STOP'
  | 'TARGET'
  | 'TIMEOUT'
  | 'SIGNAL_CLOSE'
  | 'RISK_LIMIT'
  | 'END_OF_DATA'
  | 'AMBIGUOUS_SKIPPED'

export interface Trade {
  id: string
  strategyId: string
  side: Side
  qty: number
  tag: string

  entryBar: number
  entryTime: number
  entryPrice: number
  exitBar: number
  exitTime: number
  exitPrice: number

  stopLoss: number
  takeProfit: number | null
  rDistance: number
  riskAmount: number

  exitReason: ExitReason
  grossPnl: number
  costs: number
  netPnl: number
  /** Net P&L expressed in R. The only currency-free performance unit. */
  r: number

  mfeR: number
  maeR: number
  barsHeld: number
  holdingMs: number

  /** The bar could have hit stop and target; resolved by the intrabar policy. */
  ambiguous: boolean
  /** True when SKIP_AMBIGUOUS excluded this trade from headline metrics. */
  excluded: boolean

  session: Session
  regime: Regime
  equityAfter: number
  reasons: Reason[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy
// ─────────────────────────────────────────────────────────────────────────────

/** Machine-readable justification. Recorded for taken AND rejected signals. */
export interface Reason {
  code: string
  message: string
  passed: boolean
  data?: Record<string, number | string | boolean>
}

export type Intent =
  | {
      kind: 'PLACE'
      side: Side
      type: OrderType
      price: number
      stopLoss: number
      takeProfit: number | null
      timeoutBars: number | null
      ocoGroup: string | null
      expiresAfterBars: number | null
      tag: string
    }
  | { kind: 'CANCEL'; ocoGroup: string | null; orderId: string | null }
  | { kind: 'CLOSE'; positionId: string | null; reason: string }
  | { kind: 'MOVE_STOP'; positionId: string | null; stopLoss: number }

export interface Decision {
  intents: Intent[]
  reasons: Reason[]
}

/** Indicator values precomputed for the whole series, read at index i. */
export interface Indicators {
  atr: (number | null)[]
  emaFast: (number | null)[]
  emaSlow: (number | null)[]
  rsi: (number | null)[]
  adx: (number | null)[]
  highestHigh: (number | null)[]
  lowestLow: (number | null)[]
  atrPercentile: (number | null)[]
  session: Session[]
  regime: (Regime | null)[]
  /** Higher-timeframe trend, aligned to base bars (§13 multi-timeframe). */
  htfTrend: (('UP' | 'DOWN' | 'FLAT') | null)[]
  bodyRatio: (number | null)[]
  rangeExpansion: (number | null)[]
}

/**
 * Everything a strategy may see at bar `i`.
 *
 * INVARIANT: `candles` is the FULL array but the engine guarantees the strategy
 * is only ever called with `i` = the bar that just closed, and every order it
 * places is eligible from bar i+1. Reading candles[i+1] is a bug and is proven
 * absent by `noLookAhead.test.ts`.
 */
export interface StrategyContext {
  i: number
  candle: Candle
  candles: Candle[]
  ind: Indicators
  /** All open positions. The hedge baseline deliberately holds two at once. */
  positions: Position[]
  /** Convenience alias for positions[0]. */
  position: Position | null
  pendingOrders: Order[]
  equity: number
  params: Record<string, number | string | boolean>
  instrument: Instrument
}

export interface Strategy {
  id: string
  name: string
  /** One line, shown in the UI. No hype. */
  description: string
  defaults: Record<string, number | string | boolean>
  paramSpec: ParamSpec[]
  evaluate(ctx: StrategyContext): Decision
}

export interface ParamSpec {
  key: string
  label: string
  kind: 'number' | 'boolean' | 'choice'
  min?: number
  max?: number
  step?: number
  choices?: string[]
  help: string
  /** Sweepable in the optimizer. */
  sweep?: { from: number; to: number; step: number }
}

/** Serializable — strategies are JSON, not hardcoded (§5). */
export interface StrategyConfig {
  id: string
  strategyId: string
  name: string
  params: Record<string, number | string | boolean>
  /**
   * When present, this config runs a COMPILED SPEC rather than a built-in
   * strategy. The spec travels inside the config so it crosses worker (and,
   * later, network) boundaries as plain JSON. Typed as unknown here to keep
   * the core type spine free of a dependency on the spec module.
   */
  spec?: unknown
  /** Set when the config passes out-of-sample and is locked (§13). */
  lockedAt: number | null
  /** Only bars after this date judge a locked strategy. */
  forwardTestFrom: number | null
  version: number
  createdAt: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Backtest
// ─────────────────────────────────────────────────────────────────────────────

export type IntrabarPolicy = 'CONSERVATIVE' | 'OPTIMISTIC' | 'SKIP_AMBIGUOUS'

export interface IndicatorConfig {
  atrPeriod: number
  emaFastPeriod: number
  emaSlowPeriod: number
  rsiPeriod: number
  adxPeriod: number
  lookback: number
  atrPercentileWindow: number
  htfTimeframe: Timeframe
  sessionBoundsUtc: Record<Session, [number, number]>
}

export const DEFAULT_INDICATORS: IndicatorConfig = {
  atrPeriod: 14,
  emaFastPeriod: 20,
  emaSlowPeriod: 50,
  rsiPeriod: 14,
  adxPeriod: 14,
  lookback: 20,
  atrPercentileWindow: 200,
  htfTimeframe: '1h',
  sessionBoundsUtc: {
    ASIA: [0, 7],
    LONDON: [7, 13],
    NY: [13, 21],
    OFF: [21, 24],
  },
}

export interface BacktestConfig {
  strategy: StrategyConfig
  risk: RiskConfig
  costs: CostConfig
  instrument: Instrument
  indicators: IndicatorConfig
  intrabar: IntrabarPolicy
  /** Deterministic seed for anything stochastic. */
  seed: number
  /** Optional bar-index window (used by walk-forward / IS-OOS splits). */
  fromIndex: number | null
  toIndex: number | null
}

export interface EquityPoint {
  t: number
  bar: number
  equity: number
  drawdown: number
  drawdownPct: number
  peak: number
}

export interface AmbiguityReport {
  ambiguousBars: number
  ambiguousTrades: number
  skippedTrades: number
  policy: IntrabarPolicy
}

export interface BacktestResult {
  /** Snapshot of exactly what produced these numbers (§13 reproducibility). */
  snapshot: {
    config: BacktestConfig
    datasetId: string
    datasetHash: string
    symbol: string
    timeframe: Timeframe
    bars: number
    from: number
    to: number
    engineVersion: string
    computedAt: number
  }
  trades: Trade[]
  equityCurve: EquityPoint[]
  orders: Order[]
  metrics: Metrics
  ambiguity: AmbiguityReport
  /** Reasons a signal was rejected, aggregated — shows why nothing traded. */
  rejections: Record<string, number>
  limitStops: { bar: number; time: number; reason: string }[]
  warnings: string[]
  durationMs: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

export interface ConfidenceInterval {
  point: number
  low: number
  high: number
  /** Sample size behind the estimate. Never omitted. */
  n: number
  level: number
}

export interface Metrics {
  startingEquity: number
  endingEquity: number
  netPnl: number
  returnPct: number

  trades: number
  wins: number
  losses: number
  breakEven: number
  winRate: ConfidenceInterval

  avgWin: number
  avgLoss: number
  avgR: number
  /** Expectancy per trade, in account currency and in R, with CI. */
  expectancy: number
  expectancyR: ConfidenceInterval

  profitFactor: number
  maxDrawdown: number
  maxDrawdownPct: number
  returnOverMaxDD: number

  bestTrade: number
  worstTrade: number
  maxConsecutiveWins: number
  maxConsecutiveLosses: number

  avgHoldingBars: number
  avgHoldingMs: number
  exposurePct: number

  grossPnl: number
  totalCosts: number
  costPctOfGrossProfit: number

  /** Labelled with assumptions, never the headline. */
  sharpe: number
  sortino: number
  sharpeAssumption: string

  avgMfeR: number
  avgMaeR: number

  /** Below the threshold, the UI must grey the headline (§8). */
  sampleAdequate: boolean
  sampleThreshold: number
}

export const MIN_MEANINGFUL_TRADES = 30

export const ENGINE_VERSION = '1.0.0'
