import type {
  Candle,
  DataIssue,
  DataQualityReport,
  Timeframe,
} from '../types'
import { TF_MS } from '../types'
import { inferTimeframe, utcDayOfWeek } from '../util/time'

/**
 * Data validation runs BEFORE any backtest and its report is shown, not hidden.
 * A backtest on broken data produces confident nonsense, which is the most
 * dangerous output this app could give.
 */

const MAX_REPORTED_INDICES = 25

function issue(
  code: DataIssue['code'],
  severity: DataIssue['severity'],
  message: string,
  indices: number[],
): DataIssue {
  return {
    code,
    severity,
    message,
    indices: indices.slice(0, MAX_REPORTED_INDICES),
    count: indices.length,
  }
}

export function validateCandles(
  candles: Candle[],
  declaredTf: Timeframe | null = null,
): DataQualityReport {
  const issues: DataIssue[] = []
  const n = candles.length

  if (n === 0) {
    return {
      rows: 0,
      from: 0,
      to: 0,
      inferredTimeframe: null,
      issues: [issue('BAD_OHLC', 'ERROR', 'Dataset is empty.', [])],
      usable: false,
    }
  }

  const badOhlc: number[] = []
  const nonPositive: number[] = []
  const frozen: number[] = []
  const outOfOrder: number[] = []
  const duplicates: number[] = []

  for (let i = 0; i < n; i++) {
    const c = candles[i]

    if (
      !Number.isFinite(c.o) ||
      !Number.isFinite(c.h) ||
      !Number.isFinite(c.l) ||
      !Number.isFinite(c.c) ||
      !Number.isFinite(c.t)
    ) {
      badOhlc.push(i)
      continue
    }
    if (c.o <= 0 || c.h <= 0 || c.l <= 0 || c.c <= 0) nonPositive.push(i)
    if (c.h < c.l || c.h < Math.max(c.o, c.c) || c.l > Math.min(c.o, c.c)) {
      badOhlc.push(i)
    }
    if (c.h === c.l && c.o === c.c && c.h === c.o) frozen.push(i)

    if (i > 0) {
      const prev = candles[i - 1]
      if (c.t === prev.t) duplicates.push(i)
      else if (c.t < prev.t) outOfOrder.push(i)
    }
  }

  if (badOhlc.length) {
    issues.push(
      issue(
        'BAD_OHLC',
        'ERROR',
        'Bars violate OHLC consistency (high must be ≥ max(open,close), low ≤ min(open,close), high ≥ low).',
        badOhlc,
      ),
    )
  }
  if (nonPositive.length) {
    issues.push(
      issue('NON_POSITIVE_PRICE', 'ERROR', 'Bars contain zero or negative prices.', nonPositive),
    )
  }
  if (duplicates.length) {
    issues.push(
      issue('DUPLICATE_TIMESTAMP', 'ERROR', 'Duplicate timestamps found.', duplicates),
    )
  }
  if (outOfOrder.length) {
    issues.push(
      issue('OUT_OF_ORDER', 'ERROR', 'Timestamps are not strictly increasing.', outOfOrder),
    )
  }
  if (frozen.length) {
    issues.push(
      issue(
        'FROZEN_CANDLE',
        'WARNING',
        'Bars where open = high = low = close. Usually a dead feed, a holiday, or a padded bar.',
        frozen,
      ),
    )
  }

  const times = candles.map((c) => c.t)
  const inferred = inferTimeframe(times)
  const tf = declaredTf ?? inferred

  if (declaredTf && inferred && declaredTf !== inferred) {
    issues.push(
      issue(
        'IRREGULAR_SPACING',
        'WARNING',
        `Declared timeframe ${declaredTf} but bar spacing suggests ${inferred}.`,
        [],
      ),
    )
  }

  if (tf) {
    const step = TF_MS[tf]
    const gaps: number[] = []
    const weekendGaps: number[] = []
    const irregular: number[] = []
    for (let i = 1; i < n; i++) {
      const d = times[i] - times[i - 1]
      if (d === step) continue
      if (d % step !== 0) {
        irregular.push(i)
        continue
      }
      // A clean multiple of the step = missing bars.
      const dow = utcDayOfWeek(times[i - 1])
      const isWeekendBoundary = dow === 5 || dow === 6 || utcDayOfWeek(times[i]) === 1
      if (isWeekendBoundary && d <= step * (2880 / (step / 60000) + 1)) {
        weekendGaps.push(i)
      } else {
        gaps.push(i)
      }
    }
    if (gaps.length) {
      issues.push(
        issue(
          'GAP',
          'WARNING',
          'Missing bars (feed gaps or holidays). Backtests silently treat these as instantaneous jumps.',
          gaps,
        ),
      )
    }
    if (weekendGaps.length) {
      issues.push(
        issue(
          'WEEKEND_GAP',
          'INFO',
          'Weekend / session-close gaps. Expected for FX and metals; positions held across them face gap risk.',
          weekendGaps,
        ),
      )
    }
    if (irregular.length) {
      issues.push(
        issue(
          'IRREGULAR_SPACING',
          'WARNING',
          'Bar spacing is not a whole multiple of the timeframe.',
          irregular,
        ),
      )
    }
  }

  return {
    rows: n,
    from: times[0],
    to: times[n - 1],
    inferredTimeframe: inferred,
    issues,
    usable: !issues.some((x) => x.severity === 'ERROR'),
  }
}

/** Sort by time and drop exact duplicate timestamps (keeping the last). */
export function normalizeCandles(candles: Candle[]): Candle[] {
  const sorted = [...candles].sort((a, b) => a.t - b.t)
  const out: Candle[] = []
  for (const c of sorted) {
    if (out.length && out[out.length - 1].t === c.t) out[out.length - 1] = c
    else out.push(c)
  }
  return out
}
