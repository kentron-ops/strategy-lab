import type { ConfidenceInterval, Regime, Session, Trade } from '../types'
import { meanInterval, wilsonInterval, mean } from '../util/stats'
import { regimeKey } from '../types'

/**
 * The expectancy book.
 *
 * This is the honest version of "tell me the best trade". Not a prediction —
 * a ledger of what each setup HAS done, conditioned on the context it did it in.
 *
 * Conditioning is the single most powerful legitimate lever available (§0.1):
 * an unconditional 51% can be a genuine 62% once you separate London from Asia
 * and high volatility from dead. It is also the easiest place to fool yourself,
 * because slicing multiplies the number of buckets and shrinks each one. So
 * every cell carries its sample size and confidence interval, and cells below
 * the evidence floor are labelled insufficient rather than ranked.
 */

export interface BookCell {
  setup: string
  session: Session | 'ANY'
  regime: string
  side: 'LONG' | 'SHORT' | 'ANY'

  n: number
  wins: number
  /** P(target before stop), with a Wilson interval. */
  hitRate: ConfidenceInterval
  expectancyR: ConfidenceInterval
  avgWinR: number
  avgLossR: number
  avgMfeR: number
  avgMaeR: number
  profitFactor: number

  /** Enough evidence to be ranked at all. */
  adequate: boolean
  /** Time span the cell was measured over. */
  from: number
  to: number
}

export interface ExpectancyBook {
  cells: BookCell[]
  /** Unconditional baseline, for comparing any cell against "no conditioning". */
  baseline: BookCell | null
  minSample: number
  builtFrom: { trades: number; from: number; to: number }
  warnings: string[]
}

export interface BookSpec {
  /** Cells below this are marked inadequate, not hidden. */
  minSample: number
  conditionOnSession: boolean
  conditionOnRegime: boolean
  conditionOnSide: boolean
}

export const DEFAULT_BOOK_SPEC: BookSpec = {
  minSample: 25,
  conditionOnSession: true,
  conditionOnRegime: true,
  conditionOnSide: false,
}

export function buildExpectancyBook(
  trades: Trade[],
  spec: BookSpec = DEFAULT_BOOK_SPEC,
): ExpectancyBook {
  const usable = trades.filter((t) => !t.excluded)
  const warnings: string[] = []

  if (!usable.length) {
    return {
      cells: [],
      baseline: null,
      minSample: spec.minSample,
      builtFrom: { trades: 0, from: 0, to: 0 },
      warnings: ['No trades to build a book from.'],
    }
  }

  const groups = new Map<string, Trade[]>()
  for (const t of usable) {
    const key = [
      t.tag || 'untagged',
      spec.conditionOnSession ? t.session : 'ANY',
      spec.conditionOnRegime ? regimeKey(t.regime) : 'ANY',
      spec.conditionOnSide ? t.side : 'ANY',
    ].join('|')
    const arr = groups.get(key)
    if (arr) arr.push(t)
    else groups.set(key, [t])
  }

  const cells: BookCell[] = []
  for (const [key, ts] of groups) {
    const [setup, session, regime, side] = key.split('|')
    cells.push(
      makeCell(
        ts,
        setup,
        session as Session | 'ANY',
        regime,
        side as 'LONG' | 'SHORT' | 'ANY',
        spec.minSample,
      ),
    )
  }

  const baseline = makeCell(usable, 'ALL', 'ANY', 'ANY', 'ANY', spec.minSample)

  const adequate = cells.filter((c) => c.adequate).length
  if (adequate === 0) {
    warnings.push(
      `None of the ${cells.length} conditioned cells reached ${spec.minSample} trades. Conditioning has cut the data past the point of usefulness — either widen the conditions or gather more history.`,
    )
  } else if (cells.length > usable.length / 10) {
    warnings.push(
      `${cells.length} cells from ${usable.length} trades. Slicing this finely is how noise starts looking like structure; treat any single cell with suspicion.`,
    )
  }

  cells.sort((a, b) => b.expectancyR.point - a.expectancyR.point)

  return {
    cells,
    baseline,
    minSample: spec.minSample,
    builtFrom: {
      trades: usable.length,
      from: Math.min(...usable.map((t) => t.entryTime)),
      to: Math.max(...usable.map((t) => t.exitTime)),
    },
    warnings,
  }
}

function makeCell(
  ts: Trade[],
  setup: string,
  session: Session | 'ANY',
  regime: string,
  side: 'LONG' | 'SHORT' | 'ANY',
  minSample: number,
): BookCell {
  const rs = ts.map((t) => t.r)
  const wins = ts.filter((t) => t.netPnl > 0)
  const losses = ts.filter((t) => t.netPnl < 0)
  const wr = wilsonInterval(wins.length, ts.length, 0.95)
  const ci = meanInterval(rs, 0.95)

  const grossProfit = wins.reduce((a, t) => a + t.netPnl, 0)
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0))

  return {
    setup,
    session,
    regime,
    side,
    n: ts.length,
    wins: wins.length,
    hitRate: {
      point: ts.length ? wins.length / ts.length : 0,
      low: wr.low,
      high: wr.high,
      n: ts.length,
      level: 0.95,
    },
    expectancyR: { point: ci.point, low: ci.low, high: ci.high, n: ts.length, level: 0.95 },
    avgWinR: wins.length ? mean(wins.map((t) => t.r)) : 0,
    avgLossR: losses.length ? mean(losses.map((t) => t.r)) : 0,
    avgMfeR: mean(ts.map((t) => t.mfeR)),
    avgMaeR: mean(ts.map((t) => t.maeR)),
    profitFactor:
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    adequate: ts.length >= minSample,
    from: Math.min(...ts.map((t) => t.entryTime)),
    to: Math.max(...ts.map((t) => t.exitTime)),
  }
}

/** Best-matching cell for a live context, falling back toward less conditioning. */
export function lookupCell(
  book: ExpectancyBook,
  setup: string,
  session: Session,
  regime: Regime,
  side: 'LONG' | 'SHORT',
): { cell: BookCell | null; specificity: 'EXACT' | 'PARTIAL' | 'BASELINE' } {
  const rk = regimeKey(regime)

  const exact = book.cells.find(
    (c) =>
      c.setup === setup &&
      (c.session === session || c.session === 'ANY') &&
      (c.regime === rk || c.regime === 'ANY') &&
      (c.side === side || c.side === 'ANY') &&
      c.adequate,
  )
  if (exact) return { cell: exact, specificity: 'EXACT' }

  const partial = book.cells.find((c) => c.setup === setup && c.adequate)
  if (partial) return { cell: partial, specificity: 'PARTIAL' }

  // Deliberately return the thin exact cell rather than nothing, so the UI can
  // show "insufficient evidence" with the actual number behind it.
  const thin = book.cells.find(
    (c) => c.setup === setup && (c.session === session || c.session === 'ANY'),
  )
  if (thin) return { cell: thin, specificity: 'EXACT' }

  return { cell: book.baseline, specificity: 'BASELINE' }
}

/**
 * Edge decay.
 *
 * Every edge decays. This splits a cell's trades into an older baseline and a
 * recent window and asks whether the recent period still resembles the history
 * the recommendation is built on.
 *
 * Note the asymmetry deliberately built in: a recent period that looks much
 * BETTER than baseline is flagged too. Rising apparent certainty is usually
 * overfitting or crowding, not a gift.
 */
export type DecayStatus = 'HOLDING' | 'DRIFTING' | 'DYING' | 'SUSPICIOUSLY_GOOD' | 'UNKNOWN'

export interface DecayReport {
  status: DecayStatus
  baselineExpectancyR: number
  recentExpectancyR: number
  recentN: number
  baselineN: number
  message: string
}

export function measureDecay(
  trades: Trade[],
  recentFraction = 0.25,
  minRecent = 15,
): DecayReport {
  const usable = trades.filter((t) => !t.excluded).sort((a, b) => a.entryTime - b.entryTime)
  const recentCount = Math.max(minRecent, Math.floor(usable.length * recentFraction))

  if (usable.length < minRecent * 2) {
    return {
      status: 'UNKNOWN',
      baselineExpectancyR: 0,
      recentExpectancyR: 0,
      recentN: 0,
      baselineN: usable.length,
      message: `Only ${usable.length} trades. Decay cannot be assessed until there is enough history to split.`,
    }
  }

  const recent = usable.slice(-recentCount)
  const baseline = usable.slice(0, usable.length - recentCount)

  const rBase = mean(baseline.map((t) => t.r))
  const rRecent = mean(recent.map((t) => t.r))
  const ratio = rBase !== 0 ? rRecent / rBase : 0

  let status: DecayStatus
  let message: string

  if (rBase > 0 && rRecent <= 0) {
    status = 'DYING'
    message = `Baseline ${rBase.toFixed(3)}R, most recent ${recent.length} trades ${rRecent.toFixed(3)}R. The edge has stopped working in the recent period. Stop sizing up and re-measure before trusting it again.`
  } else if (rBase > 0 && ratio < 0.5) {
    status = 'DRIFTING'
    message = `Recent performance is ${(ratio * 100).toFixed(0)}% of baseline (${rRecent.toFixed(3)}R vs ${rBase.toFixed(3)}R). Could be noise, could be decay — either way it is not the setup you measured.`
  } else if (rBase > 0 && ratio > 2.5) {
    status = 'SUSPICIOUSLY_GOOD'
    message = `Recent performance is ${(ratio * 100).toFixed(0)}% of baseline. That is a warning, not a trophy: an edge that suddenly looks this good is usually overfit, crowded, or about to mean-revert.`
  } else {
    status = 'HOLDING'
    message = `Recent ${recent.length} trades at ${rRecent.toFixed(3)}R against a ${rBase.toFixed(3)}R baseline. Consistent with the measured edge still being present.`
  }

  return {
    status,
    baselineExpectancyR: rBase,
    recentExpectancyR: rRecent,
    recentN: recent.length,
    baselineN: baseline.length,
    message,
  }
}
