import type { BacktestResult, Metrics } from '../types'

/**
 * Ranking.
 *
 * Never rank by net profit alone. Net profit is the metric most easily
 * manufactured by a single lucky trade, by a thin sample, or by a parameter set
 * that happened to sit on top of one historical move.
 */

export type ObjectiveKey =
  | 'expectancyR'
  | 'profitFactor'
  | 'returnOverMaxDD'
  | 'netPnl'
  | 'maxDrawdownPct'
  | 'trades'
  | 'winRate'
  | 'stability'

export interface Objective {
  key: ObjectiveKey
  label: string
  /** true = bigger is better. */
  higherIsBetter: boolean
  help: string
}

export const OBJECTIVES: Objective[] = [
  {
    key: 'expectancyR',
    label: 'Expectancy (R)',
    higherIsBetter: true,
    help: 'Average R per trade. The default, because it is the only figure that combines win rate and payoff without favouring either.',
  },
  {
    key: 'returnOverMaxDD',
    label: 'Return ÷ max drawdown',
    higherIsBetter: true,
    help: 'How much you made per unit of the worst pain along the way. Usually the most honest single number for comparing parameter sets.',
  },
  {
    key: 'profitFactor',
    label: 'Profit factor',
    higherIsBetter: true,
    help: 'Gross profit ÷ gross loss. Above 1 is profitable; a value above 3 on a small sample is a warning, not a triumph.',
  },
  {
    key: 'stability',
    label: 'Stability score',
    higherIsBetter: true,
    help: 'A blend of expectancy, sample size and drawdown that penalises results resting on too few trades. Deliberately hard to game.',
  },
  {
    key: 'netPnl',
    label: 'Net P&L',
    higherIsBetter: true,
    help: 'Shown because you will look for it. Ranking by it alone is how backtests get overfit.',
  },
  {
    key: 'maxDrawdownPct',
    label: 'Max drawdown %',
    higherIsBetter: false,
    help: 'The worst peak-to-trough fall. Lower is better.',
  },
  {
    key: 'winRate',
    label: 'Win rate',
    higherIsBetter: true,
    help: 'Included for completeness. Optimising it directly tends to produce tiny targets and enormous stops.',
  },
  {
    key: 'trades',
    label: 'Trade count',
    higherIsBetter: true,
    help: 'Not a performance measure — a confidence measure.',
  },
]

export function objectiveValue(m: Metrics, key: ObjectiveKey): number {
  switch (key) {
    case 'expectancyR':
      return m.expectancyR.point
    case 'profitFactor':
      return Number.isFinite(m.profitFactor) ? m.profitFactor : 0
    case 'returnOverMaxDD':
      return Number.isFinite(m.returnOverMaxDD) ? m.returnOverMaxDD : 0
    case 'netPnl':
      return m.netPnl
    case 'maxDrawdownPct':
      return m.maxDrawdownPct
    case 'trades':
      return m.trades
    case 'winRate':
      return m.winRate.point
    case 'stability':
      return stabilityScore(m)
    default:
      return 0
  }
}

/**
 * Stability score.
 *
 * Built so that a spectacular result on 12 trades cannot outrank a modest result
 * on 400. The sample term uses the LOWER bound of the expectancy confidence
 * interval, which is the honest way to say "what can we defend, not what did we
 * happen to get".
 */
export function stabilityScore(m: Metrics): number {
  if (m.trades === 0) return 0

  const lowerBound = Number.isFinite(m.expectancyR.low) ? m.expectancyR.low : -1
  // Sample weight saturates around 200 trades.
  const sampleWeight = Math.min(1, m.trades / 200)
  const ddPenalty = m.maxDrawdownPct > 0 ? 1 / (1 + m.maxDrawdownPct / 25) : 1

  return lowerBound * sampleWeight * ddPenalty
}

export interface SweepRow {
  id: string
  params: Record<string, number | string | boolean>
  metrics: Metrics
  /** Set by walk-forward / IS-OOS analysis when it has run. */
  flags: ResultFlag[]
  ambiguousTrades: number
  durationMs: number
}

export type ResultFlag =
  | 'POSSIBLE_OVERFIT'
  | 'FRAGILE'
  | 'MORE_ROBUST'
  | 'INSUFFICIENT_SAMPLE'
  | 'HIGH_AMBIGUITY'
  | 'NO_TRADES'

export const FLAG_HELP: Record<ResultFlag, string> = {
  POSSIBLE_OVERFIT:
    'Strong in-sample, weak out-of-sample. The parameters describe the past rather than the market.',
  FRAGILE:
    'Neighbouring parameter values perform far worse. This result sits on a spike, and a spike is usually luck.',
  MORE_ROBUST:
    'A broad region of nearby parameters also works. Not a guarantee — but it is what a real effect tends to look like.',
  INSUFFICIENT_SAMPLE:
    'Too few trades for the numbers to mean anything. Not ranked.',
  HIGH_AMBIGUITY:
    'A large share of trades were decided by the intrabar policy rather than by the data.',
  NO_TRADES: 'This configuration never traded.',
}

export function flagResult(result: BacktestResult): ResultFlag[] {
  const flags: ResultFlag[] = []
  if (result.metrics.trades === 0) flags.push('NO_TRADES')
  else if (!result.metrics.sampleAdequate) flags.push('INSUFFICIENT_SAMPLE')
  const ambiguousShare =
    result.trades.length > 0 ? result.ambiguity.ambiguousTrades / result.trades.length : 0
  if (ambiguousShare > 0.25) flags.push('HIGH_AMBIGUITY')
  return flags
}

export function rankRows(
  rows: SweepRow[],
  key: ObjectiveKey,
  { demoteInadequate = true }: { demoteInadequate?: boolean } = {},
): SweepRow[] {
  const obj = OBJECTIVES.find((o) => o.key === key)
  const higher = obj?.higherIsBetter ?? true

  return [...rows].sort((a, b) => {
    if (demoteInadequate) {
      const aBad = a.flags.includes('INSUFFICIENT_SAMPLE') || a.flags.includes('NO_TRADES')
      const bBad = b.flags.includes('INSUFFICIENT_SAMPLE') || b.flags.includes('NO_TRADES')
      if (aBad !== bBad) return aBad ? 1 : -1
    }
    const av = objectiveValue(a.metrics, key)
    const bv = objectiveValue(b.metrics, key)
    return higher ? bv - av : av - bv
  })
}
