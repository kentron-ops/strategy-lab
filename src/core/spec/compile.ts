import type {
  Candle,
  Decision,
  Intent,
  ParamSpec,
  Reason,
  Strategy,
  StrategyContext,
} from '../types'
import type { Comparator, Condition, FilterNode, Operand, RuleGroup, StrategySpec } from './types'
import { CMP_LABEL, operandLabel } from './types'
import { atr, adx, ema, rollingHigh, rollingLow, rsi, sma } from '../indicators'
import { hashObject } from '../util/hash'
import { sessionAllowed } from '../strategy/helpers'

/**
 * Spec compiler: StrategySpec (JSON) → Strategy (the engine's interface).
 *
 * Causality contract: every operand series is computed with the same causal
 * indicator functions the engine already tests, and conditions are evaluated at
 * the CLOSE of bar i, producing orders eligible from bar i+1 — so a compiled
 * spec inherits the engine's no-look-ahead proof.
 *
 * Key numeric fields are exposed as engine params (with the spec values as
 * defaults) so the sweep, robustness and walk-forward machinery works on
 * compiled specs exactly as it does on the built-in strategies.
 */

// Per-dataset operand-series cache. Keyed by the candles array identity, so a
// re-run over the same dataset pays the indicator cost once, and a different
// dataset can never leak cached values.
const seriesCache = new WeakMap<Candle[], Map<string, (number | null)[]>>()

function seriesFor(
  candles: Candle[],
  key: string,
  build: () => (number | null)[],
): (number | null)[] {
  let bucket = seriesCache.get(candles)
  if (!bucket) {
    bucket = new Map()
    seriesCache.set(candles, bucket)
  }
  let s = bucket.get(key)
  if (!s) {
    s = build()
    bucket.set(key, s)
  }
  return s
}

/** Value of an operand at bar i (null while warming up). */
function operandAt(o: Operand, ctx: StrategyContext, i: number): number | null {
  const { candles } = ctx
  switch (o.type) {
    case 'price':
      return candles[i][o.field === 'open' ? 'o' : o.field === 'high' ? 'h' : o.field === 'low' ? 'l' : 'c']
    case 'prevPrice': {
      if (i === 0) return null
      const c = candles[i - 1]
      return c[o.field === 'open' ? 'o' : o.field === 'high' ? 'h' : o.field === 'low' ? 'l' : 'c']
    }
    case 'value':
      return o.value
    case 'ema':
      return seriesFor(candles, `ema:${o.period}`, () => ema(candles.map((c) => c.c), o.period))[i]
    case 'sma':
      return seriesFor(candles, `sma:${o.period}`, () => sma(candles.map((c) => c.c), o.period))[i]
    case 'rsi':
      return seriesFor(candles, `rsi:${o.period}`, () => rsi(candles, o.period))[i]
    case 'atr':
      return seriesFor(candles, `atr:${o.period}`, () => atr(candles, o.period))[i]
    case 'adx':
      return seriesFor(candles, `adx:${o.period}`, () => adx(candles, o.period))[i]
    case 'rollingHigh':
      return seriesFor(candles, `rh:${o.period}`, () => rollingHigh(candles, o.period, true))[i]
    case 'rollingLow':
      return seriesFor(candles, `rl:${o.period}`, () => rollingLow(candles, o.period, true))[i]
    case 'atrPercentile':
      return ctx.ind.atrPercentile[i]
    case 'rangeExpansion':
      return ctx.ind.rangeExpansion[i]
    case 'bodyRatio':
      return ctx.ind.bodyRatio[i]
    case 'atrOffset': {
      const base = operandAt(o.base, ctx, i)
      const a = seriesFor(candles, `atr:${o.atrPeriod}`, () => atr(candles, o.atrPeriod))[i]
      if (base === null || a === null) return null
      return base + a * o.multiple
    }
  }
}

/** Evaluate a condition at bar i. Null operands (warm-up) fail the condition. */
function conditionAt(c: Condition, ctx: StrategyContext, i: number): boolean | null {
  const L = operandAt(c.left, ctx, i)
  const R = operandAt(c.right, ctx, i)
  if (L === null || R === null) return null

  switch (c.cmp) {
    case 'GT':
      return L > R
    case 'GTE':
      return L >= R
    case 'LT':
      return L < R
    case 'LTE':
      return L <= R
    case 'WITHIN':
      return Math.abs(L - R) <= (c.tolerance ?? 0)
    case 'CROSS_ABOVE':
    case 'CROSS_BELOW': {
      if (i === 0) return null
      const Lp = operandAt(c.left, ctx, i - 1)
      const Rp = operandAt(c.right, ctx, i - 1)
      if (Lp === null || Rp === null) return null
      return c.cmp === 'CROSS_ABOVE' ? Lp <= Rp && L > R : Lp >= Rp && L < R
    }
  }
}

function groupAt(g: RuleGroup, ctx: StrategyContext, i: number): boolean | null {
  if (!g.rules.length) return true
  let sawNull = false
  for (const r of g.rules) {
    const v = r.kind === 'group' ? groupAt(r, ctx, i) : conditionAt(r, ctx, i)
    if (v === null) {
      sawNull = true
      continue
    }
    if (g.op === 'AND' && !v) return false
    if (g.op === 'OR' && v) return true
  }
  if (sawNull) return null // warm-up: refuse to trade rather than guess
  return g.op === 'AND'
}

function describeGroup(g: RuleGroup): string {
  const parts = g.rules.map((r) =>
    r.kind === 'group'
      ? `(${describeGroup(r)})`
      : `${operandLabel(r.left)} ${CMP_LABEL[r.cmp]} ${operandLabel(r.right)}`,
  )
  return parts.join(g.op === 'AND' ? ' AND ' : ' OR ')
}

const P = {
  lookback: 'spec_lookback',
  buffer: 'spec_bufferAtr',
  stop: 'spec_stopValue',
  target: 'spec_targetValue',
  timeout: 'spec_timeoutBars',
  interval: 'spec_intervalBars',
  expiry: 'spec_orderExpiryBars',
} as const

/** Compile a validated spec into an engine Strategy. */
export function compileSpec(spec: StrategySpec): Strategy {
  const id = specStrategyId(spec)
  const atrPeriod = spec.exit.stop.atrPeriod ?? 14

  const defaults: Record<string, number | string | boolean> = {
    [P.stop]: spec.exit.stop.value,
    [P.target]: spec.exit.target?.value ?? 0,
    [P.timeout]: spec.exit.timeoutBars ?? 0,
  }
  const paramSpec: ParamSpec[] = [
    {
      key: P.stop,
      label: `Stop (${spec.exit.stop.unit})`,
      kind: 'number',
      min: 0.05,
      max: 50,
      step: 0.05,
      help: 'Stop distance from the spec. This distance is 1R.',
      sweep: sweepAround(spec.exit.stop.value),
    },
    {
      key: P.target,
      label: `Target (${spec.exit.target?.unit ?? 'R'})`,
      kind: 'number',
      min: 0,
      max: 50,
      step: 0.1,
      help: 'Target from the spec. 0 = no target.',
      sweep: spec.exit.target ? sweepAround(spec.exit.target.value) : undefined,
    },
    {
      key: P.timeout,
      label: 'Timeout (bars)',
      kind: 'number',
      min: 0,
      max: 5000,
      step: 1,
      help: 'Bars before a forced close. 0 disables.',
    },
  ]

  if (spec.entryMode.mode === 'BREAKOUT_OCO') {
    defaults[P.lookback] = spec.entryMode.lookback
    defaults[P.buffer] = spec.entryMode.bufferAtrMultiple
    defaults[P.expiry] = spec.entryMode.orderExpiryBars
    paramSpec.push(
      {
        key: P.lookback,
        label: 'Range lookback',
        kind: 'number',
        min: 2,
        max: 500,
        step: 1,
        help: 'Bars defining the breakout range.',
        sweep: sweepAround(spec.entryMode.lookback, true),
      },
      {
        key: P.buffer,
        label: 'Buffer (ATR ×)',
        kind: 'number',
        min: 0,
        max: 3,
        step: 0.05,
        help: 'Distance beyond the range edge.',
      },
      {
        key: P.expiry,
        label: 'Order expiry (bars)',
        kind: 'number',
        min: 1,
        max: 500,
        step: 1,
        help: 'Cancel untriggered entries after this many bars.',
      },
    )
  }
  if (spec.entryMode.mode === 'CADENCE') {
    defaults[P.interval] = spec.entryMode.intervalBars
    paramSpec.push({
      key: P.interval,
      label: 'Interval (bars)',
      kind: 'number',
      min: 1,
      max: 2000,
      step: 1,
      help: 'Bars between cadence entries.',
      sweep: sweepAround(spec.entryMode.intervalBars, true),
    })
  }

  const sessionFilters = spec.filters.filter(
    (f): f is Extract<FilterNode, { kind: 'session' }> => 'kind' in f && f.kind === 'session',
  )
  const htfFilter = spec.filters.some(
    (f) => 'kind' in f && f.kind === 'htfAlignment' && (f as { enabled: boolean }).enabled,
  )
  const ruleFilters = spec.filters.filter(
    (f): f is Condition | RuleGroup =>
      !('kind' in f && (f.kind === 'session' || f.kind === 'htfAlignment')),
  )
  const filterGroup: RuleGroup = {
    kind: 'group',
    op: 'AND',
    rules: ruleFilters.map((f) => ('kind' in f && f.kind === 'group' ? f : (f as Condition))),
  }

  const evaluate = (ctx: StrategyContext): Decision => {
    const reasons: Reason[] = []
    const intents: Intent[] = []
    const i = ctx.i
    const p = ctx.params

    if (ctx.positions.length > 0) {
      reasons.push(r('POSITION_OPEN', 'Position open; not arming.', false))
      return { intents, reasons }
    }
    if (ctx.pendingOrders.some((o) => o.status === 'PENDING')) {
      reasons.push(r('ORDERS_WORKING', 'Orders already working.', false))
      return { intents, reasons }
    }

    const atrSeries = seriesFor(ctx.candles, `atr:${atrPeriod}`, () => atr(ctx.candles, atrPeriod))
    const a = atrSeries[i]
    if (a === null) {
      reasons.push(r('WARMUP', 'ATR warming up.', false))
      return { intents, reasons }
    }

    // ── filters
    for (const sf of sessionFilters) {
      const session = ctx.ind.session[i]
      if (!sessionAllowed(sf.sessions.join(','), session)) {
        reasons.push(r('SESSION_BLOCKED', `Session ${session} not allowed.`, false, { session }))
        return { intents, reasons }
      }
    }
    if (filterGroup.rules.length) {
      const ok = groupAt(filterGroup, ctx, i)
      if (ok === null) {
        reasons.push(r('FILTER_WARMUP', 'A filter series is still warming up.', false))
        return { intents, reasons }
      }
      if (!ok) {
        reasons.push(r('FILTER_BLOCKED', `Filter failed: ${describeGroup(filterGroup)}`, false))
        return { intents, reasons }
      }
    }
    let allowLong = spec.direction !== 'short'
    let allowShort = spec.direction !== 'long'
    if (htfFilter) {
      const htf = ctx.ind.htfTrend[i]
      if (htf === null) {
        reasons.push(r('HTF_WARMUP', 'Higher-timeframe trend warming up.', false))
        return { intents, reasons }
      }
      allowLong = allowLong && htf === 'UP'
      allowShort = allowShort && htf === 'DOWN'
      if (!allowLong && !allowShort) {
        reasons.push(r('HTF_FLAT', 'Higher-timeframe trend does not favour either side.', false, { htf }))
        return { intents, reasons }
      }
    }

    // ── stop / target geometry in price units
    const stopValue = num(p[P.stop], spec.exit.stop.value)
    const stopDist = spec.exit.stop.unit === 'ATR' ? a * stopValue : stopValue
    if (!(stopDist > 0)) {
      reasons.push(r('BAD_STOP', 'Stop distance is not positive.', false))
      return { intents, reasons }
    }
    const targetValue = num(p[P.target], spec.exit.target?.value ?? 0)
    const targetDist =
      targetValue <= 0 || !spec.exit.target
        ? null
        : spec.exit.target.unit === 'R'
          ? stopDist * targetValue
          : spec.exit.target.unit === 'ATR'
            ? a * targetValue
            : targetValue
    const timeoutBars = Math.round(num(p[P.timeout], spec.exit.timeoutBars ?? 0)) || null

    // ── entries by mode
    if (spec.entryMode.mode === 'CADENCE') {
      const interval = Math.max(1, Math.round(num(p[P.interval], spec.entryMode.intervalBars)))
      if (i % interval !== 0) {
        reasons.push(r('OFF_CADENCE', `Not an entry bar (every ${interval}).`, false))
        return { intents, reasons }
      }
      const price = ctx.candle.c
      const both = spec.entryMode.simultaneousBothSides
      reasons.push(r('CADENCE_ENTRY', `Cadence entry (${describeGroup(spec.entry) || 'unconditional'}).`, true))
      if (allowLong) intents.push(place('LONG', 'MARKET', price, stopDist, targetDist, timeoutBars, null, 1))
      if (allowShort && (both || !allowLong)) {
        intents.push(place('SHORT', 'MARKET', price, stopDist, targetDist, timeoutBars, null, 1))
      }
      return { intents, reasons }
    }

    if (spec.entryMode.mode === 'MARKET') {
      const longOk = allowLong ? groupAt(spec.entry, ctx, i) : false
      const shortOk =
        allowShort && spec.entryShort ? groupAt(spec.entryShort, ctx, i) : false
      if (longOk === null || shortOk === null) {
        reasons.push(r('RULE_WARMUP', 'An entry series is still warming up.', false))
        return { intents, reasons }
      }
      if (!longOk && !shortOk) {
        reasons.push(r('NO_SIGNAL', `Entry rules not met: ${describeGroup(spec.entry)}`, false))
        return { intents, reasons }
      }
      const price = ctx.candle.c
      if (longOk) {
        reasons.push(r('ENTRY_LONG', `Long rules met: ${describeGroup(spec.entry)}`, true))
        intents.push(place('LONG', 'MARKET', price, stopDist, targetDist, timeoutBars, null, 1))
      } else if (shortOk && spec.entryShort) {
        reasons.push(r('ENTRY_SHORT', `Short rules met: ${describeGroup(spec.entryShort)}`, true))
        intents.push(place('SHORT', 'MARKET', price, stopDist, targetDist, timeoutBars, null, 1))
      }
      return { intents, reasons }
    }

    // BREAKOUT_OCO
    const lookback = Math.max(2, Math.round(num(p[P.lookback], spec.entryMode.lookback)))
    const buffer = num(p[P.buffer], spec.entryMode.bufferAtrMultiple)
    const expiry = Math.max(1, Math.round(num(p[P.expiry], spec.entryMode.orderExpiryBars)))

    const entryOk = groupAt(spec.entry, ctx, i)
    if (entryOk === null) {
      reasons.push(r('RULE_WARMUP', 'An entry series is still warming up.', false))
      return { intents, reasons }
    }
    if (!entryOk) {
      reasons.push(r('NO_SIGNAL', `Entry rules not met: ${describeGroup(spec.entry) || 'none'}`, false))
      return { intents, reasons }
    }

    const hi = seriesFor(ctx.candles, `rh:${lookback}`, () => rollingHigh(ctx.candles, lookback, true))[i]
    const lo = seriesFor(ctx.candles, `rl:${lookback}`, () => rollingLow(ctx.candles, lookback, true))[i]
    if (hi === null || lo === null) {
      reasons.push(r('WARMUP', `Fewer than ${lookback} completed bars.`, false))
      return { intents, reasons }
    }
    const pad = a * buffer
    const buyTrigger = hi + pad
    const sellTrigger = lo - pad
    if (buyTrigger - sellTrigger <= 0) {
      reasons.push(r('BAD_RANGE', 'Range collapsed; triggers would cross.', false))
      return { intents, reasons }
    }

    const group = allowLong && allowShort ? `spec_oco_${spec.id}` : null
    reasons.push(
      r('ARM_OCO', `Arming breakout around ${lookback}-bar range.`, true, {
        rangeHigh: hi,
        rangeLow: lo,
      }),
    )
    if (allowLong) {
      intents.push(place('LONG', 'STOP', buyTrigger, stopDist, targetDist, timeoutBars, group, expiry))
    }
    if (allowShort) {
      intents.push(place('SHORT', 'STOP', sellTrigger, stopDist, targetDist, timeoutBars, group, expiry))
    }
    return { intents, reasons }
  }

  return {
    id,
    name: spec.name,
    description: `Compiled spec ${spec.id} (v${spec.meta.specVersion})`,
    defaults,
    paramSpec,
    evaluate,
  }
}

export function specStrategyId(spec: StrategySpec): string {
  return `spec_${spec.id}_${hashObject({
    entry: spec.entry,
    entryShort: spec.entryShort,
    entryMode: spec.entryMode,
    exit: spec.exit,
    filters: spec.filters,
    direction: spec.direction,
  })}`
}

function place(
  side: 'LONG' | 'SHORT',
  type: 'MARKET' | 'STOP',
  price: number,
  stopDist: number,
  targetDist: number | null,
  timeoutBars: number | null,
  ocoGroup: string | null,
  expiresAfterBars: number,
): Intent {
  return {
    kind: 'PLACE',
    side,
    type,
    price,
    stopLoss: side === 'LONG' ? price - stopDist : price + stopDist,
    takeProfit:
      targetDist === null ? null : side === 'LONG' ? price + targetDist : price - targetDist,
    timeoutBars,
    ocoGroup,
    expiresAfterBars,
    tag: `spec_${side.toLowerCase()}`,
  }
}

const r = (
  code: string,
  message: string,
  passed: boolean,
  data?: Record<string, number | string | boolean>,
): Reason => ({ code, message, passed, ...(data ? { data } : {}) })

const num = (v: number | string | boolean | undefined, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

function sweepAround(value: number, integer = false): { from: number; to: number; step: number } {
  const from = integer ? Math.max(2, Math.round(value * 0.5)) : Number((value * 0.5).toFixed(4))
  const to = integer ? Math.round(value * 1.5) : Number((value * 1.5).toFixed(4))
  const step = integer ? Math.max(1, Math.round(value / 4)) : Number((value / 4).toFixed(4)) || 0.1
  return { from, to, step }
}
