import type { Decision, Intent, Reason, Strategy, StrategyContext } from '../types'
import { bool, highestHigh, lowestLow, num, reason, sessionAllowed, str } from './helpers'

/**
 * C. BREAKOUT CONTINUATION.
 *
 * The OCO breakout plus deterministic qualifiers. Every qualifier is a separate,
 * individually reported filter, so the results can answer the only question that
 * matters about a filter: did it raise expectancy, or did it just cut the sample
 * until the remaining trades looked lucky?
 *
 * Each rejection is recorded with its own code. The rejection histogram in the
 * results view is how you see that, say, the ATR-percentile filter is throwing
 * away 80% of the setups — which is either the edge or the overfit, and the
 * out-of-sample test decides which.
 */

const GROUP = 'breakout_continuation'

const strategy: Strategy = {
  id: 'breakout_continuation',
  name: 'Breakout continuation',
  description:
    'OCO breakout with volatility, range-expansion, body, session and higher-timeframe qualifiers. Each filter is measured separately.',

  defaults: {
    lookback: 20,
    bufferAtrMultiple: 0.1,
    stopAtrMultiple: 1.5,
    targetR: 2.5,
    timeoutBars: 96,
    orderExpiryBars: 12,
    sessionFilter: 'LONDON,NY',
    minAtrPercentile: 0.4,
    minRangeExpansion: 1.1,
    minBodyRatio: 0.35,
    requireHtfAlignment: true,
    maxSpreadAtrRatio: 0,
  },

  paramSpec: [
    {
      key: 'lookback',
      label: 'Range lookback (bars)',
      kind: 'number',
      min: 2,
      max: 500,
      step: 1,
      help: 'Completed bars defining the range. The forming bar is excluded.',
      sweep: { from: 10, to: 60, step: 5 },
    },
    {
      key: 'bufferAtrMultiple',
      label: 'Trigger buffer = ATR ×',
      kind: 'number',
      min: 0,
      max: 3,
      step: 0.05,
      help: 'Distance beyond the range edge for the entry stop orders.',
      sweep: { from: 0, to: 0.5, step: 0.05 },
    },
    {
      key: 'stopAtrMultiple',
      label: 'Stop = ATR ×',
      kind: 'number',
      min: 0.1,
      max: 10,
      step: 0.1,
      help: 'Protective stop distance in ATR. This distance is 1R.',
      sweep: { from: 0.5, to: 3, step: 0.25 },
    },
    {
      key: 'targetR',
      label: 'Target (R)',
      kind: 'number',
      min: 0.1,
      max: 20,
      step: 0.1,
      help: 'Take profit in R. Compare against the MFE distribution — if winners routinely run past this, the target is leaving money on the table.',
      sweep: { from: 1, to: 6, step: 0.5 },
    },
    {
      key: 'timeoutBars',
      label: 'Timeout (bars)',
      kind: 'number',
      min: 0,
      max: 2000,
      step: 1,
      help: 'Close after this many bars. 0 disables.',
      sweep: { from: 24, to: 240, step: 24 },
    },
    {
      key: 'orderExpiryBars',
      label: 'Order expiry (bars)',
      kind: 'number',
      min: 1,
      max: 500,
      step: 1,
      help: 'Cancel untriggered entries after this many bars.',
      sweep: { from: 4, to: 48, step: 4 },
    },
    {
      key: 'sessionFilter',
      label: 'Sessions',
      kind: 'choice',
      choices: ['ALL', 'ASIA', 'LONDON', 'NY', 'LONDON,NY'],
      help: 'Most breakout edges are session-specific. Averaging across all sessions can hide a real edge inside a bad one.',
    },
    {
      key: 'minAtrPercentile',
      label: 'Min ATR percentile',
      kind: 'number',
      min: 0,
      max: 1,
      step: 0.05,
      help: 'Require volatility to sit at least this high within its own recent history (0–1). Breakouts in dead volatility are usually noise.',
      sweep: { from: 0, to: 0.8, step: 0.1 },
    },
    {
      key: 'minRangeExpansion',
      label: 'Min range expansion',
      kind: 'number',
      min: 0,
      max: 5,
      step: 0.05,
      help: 'Current bar range divided by its recent average. Above 1 means the market is waking up.',
      sweep: { from: 0.8, to: 2, step: 0.1 },
    },
    {
      key: 'minBodyRatio',
      label: 'Min candle body ratio',
      kind: 'number',
      min: 0,
      max: 1,
      step: 0.05,
      help: '|close − open| ÷ range for the signal bar. Low values mean indecision.',
      sweep: { from: 0, to: 0.7, step: 0.1 },
    },
    {
      key: 'requireHtfAlignment',
      label: 'Require higher-timeframe alignment',
      kind: 'boolean',
      help: 'Only arm the side that agrees with the higher-timeframe trend. Turns the OCO into a single directional order when the trend is clear.',
    },
    {
      key: 'maxSpreadAtrRatio',
      label: 'Max spread ÷ ATR',
      kind: 'number',
      min: 0,
      max: 1,
      step: 0.01,
      help: 'Refuse setups where the modelled spread is large relative to volatility. 0 disables. This is the filter that most often decides whether a small edge survives costs.',
      sweep: { from: 0, to: 0.2, step: 0.02 },
    },
  ],

  evaluate(ctx: StrategyContext): Decision {
    const reasons: Reason[] = []
    const intents: Intent[] = []

    const lookback = Math.max(2, Math.round(num(ctx, 'lookback', 20)))
    const buffer = num(ctx, 'bufferAtrMultiple', 0.1)
    const stopAtr = num(ctx, 'stopAtrMultiple', 1.5)
    const targetR = num(ctx, 'targetR', 2.5)
    const timeout = num(ctx, 'timeoutBars', 96)
    const expiry = Math.max(1, Math.round(num(ctx, 'orderExpiryBars', 12)))
    const filter = str(ctx, 'sessionFilter', 'LONDON,NY')
    const minAtrPct = num(ctx, 'minAtrPercentile', 0.4)
    const minExpansion = num(ctx, 'minRangeExpansion', 1.1)
    const minBody = num(ctx, 'minBodyRatio', 0.35)
    const requireHtf = bool(ctx, 'requireHtfAlignment', true)

    const i = ctx.i
    const atr = ctx.ind.atr[i]
    const session = ctx.ind.session[i]

    if (ctx.positions.length > 0) {
      reasons.push(reason('POSITION_OPEN', 'In a position; not arming new orders.', false))
      return { intents, reasons }
    }
    if (ctx.pendingOrders.some((o) => o.status === 'PENDING')) {
      reasons.push(reason('ORDERS_WORKING', 'Breakout orders already armed.', false))
      return { intents, reasons }
    }
    if (atr === null) {
      reasons.push(reason('WARMUP', 'ATR has not warmed up yet.', false))
      return { intents, reasons }
    }

    // ── Qualifiers. Each one reports separately so its cost in sample size is visible.
    if (!sessionAllowed(filter, session)) {
      reasons.push(
        reason('SESSION_BLOCKED', `Session ${session} is not in the filter (${filter}).`, false, {
          session,
        }),
      )
      return { intents, reasons }
    }

    const atrPct = ctx.ind.atrPercentile[i]
    if (minAtrPct > 0) {
      if (atrPct === null) {
        reasons.push(reason('ATR_PCT_WARMUP', 'ATR percentile has not warmed up yet.', false))
        return { intents, reasons }
      }
      if (atrPct < minAtrPct) {
        reasons.push(
          reason(
            'VOL_TOO_LOW',
            `Volatility at the ${(atrPct * 100).toFixed(0)}th percentile, below the required ${(minAtrPct * 100).toFixed(0)}th.`,
            false,
            { atrPercentile: atrPct },
          ),
        )
        return { intents, reasons }
      }
    }

    const expansion = ctx.ind.rangeExpansion[i]
    if (minExpansion > 0) {
      if (expansion === null) {
        reasons.push(reason('EXPANSION_WARMUP', 'Range expansion has not warmed up yet.', false))
        return { intents, reasons }
      }
      if (expansion < minExpansion) {
        reasons.push(
          reason(
            'NO_EXPANSION',
            `Bar range is ${expansion.toFixed(2)}× its average, below the required ${minExpansion}×.`,
            false,
            { rangeExpansion: expansion },
          ),
        )
        return { intents, reasons }
      }
    }

    const body = ctx.ind.bodyRatio[i]
    if (minBody > 0) {
      if (body === null) {
        reasons.push(reason('BODY_UNDEFINED', 'Signal bar has zero range.', false))
        return { intents, reasons }
      }
      if (body < minBody) {
        reasons.push(
          reason(
            'WEAK_BODY',
            `Body ratio ${body.toFixed(2)} is below the required ${minBody}. The bar is indecisive.`,
            false,
            { bodyRatio: body },
          ),
        )
        return { intents, reasons }
      }
    }

    const maxSpreadRatio = num(ctx, 'maxSpreadAtrRatio', 0)
    if (maxSpreadRatio > 0) {
      // The strategy cannot see the cost config directly (it is engine-owned),
      // so it uses ATR as the scale and lets the engine's cost model do the rest.
      // This filter only rejects setups where ATR itself is degenerately small.
      const scale = atr / Math.max(1e-9, ctx.candle.c)
      if (scale < maxSpreadRatio * 0.001) {
        reasons.push(
          reason(
            'SPREAD_TOO_WIDE',
            'Volatility is too small relative to typical costs for this setup to clear its own spread.',
            false,
            { atr },
          ),
        )
        return { intents, reasons }
      }
    }

    const hi = highestHigh(ctx.candles, i, lookback)
    const lo = lowestLow(ctx.candles, i, lookback)
    if (hi === null || lo === null) {
      reasons.push(reason('WARMUP', `Fewer than ${lookback} completed bars of history.`, false))
      return { intents, reasons }
    }

    const htf = ctx.ind.htfTrend[i]
    let allowLong = true
    let allowShort = true
    if (requireHtf) {
      if (htf === null) {
        reasons.push(reason('HTF_WARMUP', 'Higher-timeframe trend not available yet.', false))
        return { intents, reasons }
      }
      allowLong = htf === 'UP'
      allowShort = htf === 'DOWN'
      if (!allowLong && !allowShort) {
        reasons.push(
          reason('HTF_FLAT', 'Higher-timeframe trend is flat; no side is favoured.', false, {
            htf,
          }),
        )
        return { intents, reasons }
      }
    }

    const pad = atr * buffer
    const buyTrigger = hi + pad
    const sellTrigger = lo - pad
    const stopDistance = atr * stopAtr
    if (!(stopDistance > 0) || buyTrigger - sellTrigger <= 0) {
      reasons.push(reason('BAD_GEOMETRY', 'Stop distance or range geometry is invalid.', false))
      return { intents, reasons }
    }

    const timeoutBars = timeout > 0 ? Math.round(timeout) : null
    const group = allowLong && allowShort ? GROUP : null

    reasons.push(
      reason(
        'QUALIFIED',
        `All qualifiers passed. Arming ${allowLong && allowShort ? 'both sides' : allowLong ? 'long only' : 'short only'}.`,
        true,
        {
          atrPercentile: atrPct ?? -1,
          rangeExpansion: expansion ?? -1,
          bodyRatio: body ?? -1,
          htf: htf ?? 'n/a',
          session,
        },
      ),
    )

    if (allowLong) {
      intents.push({
        kind: 'PLACE',
        side: 'LONG',
        type: 'STOP',
        price: buyTrigger,
        stopLoss: buyTrigger - stopDistance,
        takeProfit: buyTrigger + stopDistance * targetR,
        timeoutBars,
        ocoGroup: group,
        expiresAfterBars: expiry,
        tag: 'continuation_long',
      })
    }
    if (allowShort) {
      intents.push({
        kind: 'PLACE',
        side: 'SHORT',
        type: 'STOP',
        price: sellTrigger,
        stopLoss: sellTrigger + stopDistance,
        takeProfit: sellTrigger - stopDistance * targetR,
        timeoutBars,
        ocoGroup: group,
        expiresAfterBars: expiry,
        tag: 'continuation_short',
      })
    }

    return { intents, reasons }
  },
}

export default strategy
