import type { Decision, Intent, Reason, Strategy, StrategyContext } from '../types'
import { highestHigh, lowestLow, num, reason, sessionAllowed, str } from './helpers'

/**
 * B. OCO BREAKOUT.
 *
 * A buy stop above the recent range and a sell stop below it, linked so that the
 * first to trigger cancels the other. This is the honest version of the hedge
 * idea: the same "catch the move whichever way it goes" intent, but paying the
 * entry cost ONCE instead of twice.
 *
 * The comparison between this and the hedge baseline is the first real question
 * the lab answers.
 */

const GROUP = 'oco_breakout'

const strategy: Strategy = {
  id: 'oco_breakout',
  name: 'OCO breakout',
  description:
    'Buy stop above the range, sell stop below it, one cancels the other. The hedge idea with the cost paid once.',

  defaults: {
    lookback: 20,
    bufferAtrMultiple: 0.1,
    stopAtrMultiple: 1.5,
    targetR: 2,
    timeoutBars: 96,
    orderExpiryBars: 12,
    sessionFilter: 'ALL',
    cooldownBars: 0,
  },

  paramSpec: [
    {
      key: 'lookback',
      label: 'Range lookback (bars)',
      kind: 'number',
      min: 2,
      max: 500,
      step: 1,
      help: 'How many completed bars define the range being broken. The current bar is always excluded — using it would be look-ahead.',
      sweep: { from: 10, to: 60, step: 5 },
    },
    {
      key: 'bufferAtrMultiple',
      label: 'Trigger buffer = ATR ×',
      kind: 'number',
      min: 0,
      max: 3,
      step: 0.05,
      help: 'How far beyond the range edge the stop orders sit. Larger values reject marginal pokes through the level at the cost of a worse entry.',
      sweep: { from: 0, to: 0.5, step: 0.05 },
    },
    {
      key: 'stopAtrMultiple',
      label: 'Stop = ATR ×',
      kind: 'number',
      min: 0.1,
      max: 10,
      step: 0.1,
      help: 'Protective stop distance in ATR, measured from the entry. This distance is 1R.',
      sweep: { from: 0.5, to: 3, step: 0.25 },
    },
    {
      key: 'targetR',
      label: 'Target (R)',
      kind: 'number',
      min: 0.1,
      max: 20,
      step: 0.1,
      help: 'Take profit as a multiple of the stop distance. Expectancy usually cares far more about this than about win rate.',
      sweep: { from: 0.5, to: 5, step: 0.5 },
    },
    {
      key: 'timeoutBars',
      label: 'Timeout (bars)',
      kind: 'number',
      min: 0,
      max: 2000,
      step: 1,
      help: 'Close the position after this many bars regardless. 0 disables.',
      sweep: { from: 24, to: 240, step: 24 },
    },
    {
      key: 'orderExpiryBars',
      label: 'Order expiry (bars)',
      kind: 'number',
      min: 1,
      max: 500,
      step: 1,
      help: 'Cancel untriggered entry orders after this many bars, then re-place against the new range.',
      sweep: { from: 4, to: 48, step: 4 },
    },
    {
      key: 'sessionFilter',
      label: 'Sessions',
      kind: 'choice',
      choices: ['ALL', 'ASIA', 'LONDON', 'NY', 'LONDON,NY'],
      help: 'Only place orders during these sessions.',
    },
    {
      key: 'cooldownBars',
      label: 'Cooldown after exit (bars)',
      kind: 'number',
      min: 0,
      max: 500,
      step: 1,
      help: 'Wait this many bars after a trade closes before arming again. Blunts the re-entry churn that eats breakout systems.',
      sweep: { from: 0, to: 48, step: 6 },
    },
  ],

  evaluate(ctx: StrategyContext): Decision {
    const reasons: Reason[] = []
    const intents: Intent[] = []

    const lookback = Math.max(2, Math.round(num(ctx, 'lookback', 20)))
    const buffer = num(ctx, 'bufferAtrMultiple', 0.1)
    const stopAtr = num(ctx, 'stopAtrMultiple', 1.5)
    const targetR = num(ctx, 'targetR', 2)
    const timeout = num(ctx, 'timeoutBars', 96)
    const expiry = Math.max(1, Math.round(num(ctx, 'orderExpiryBars', 12)))
    const filter = str(ctx, 'sessionFilter', 'ALL')

    const atr = ctx.ind.atr[ctx.i]
    const session = ctx.ind.session[ctx.i]

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

    if (!sessionAllowed(filter, session)) {
      reasons.push(
        reason('SESSION_BLOCKED', `Session ${session} is not in the filter (${filter}).`, false, {
          session,
        }),
      )
      return { intents, reasons }
    }

    const hi = highestHigh(ctx.candles, ctx.i, lookback)
    const lo = lowestLow(ctx.candles, ctx.i, lookback)
    if (hi === null || lo === null) {
      reasons.push(reason('WARMUP', `Fewer than ${lookback} completed bars of history.`, false))
      return { intents, reasons }
    }

    const pad = atr * buffer
    const buyTrigger = hi + pad
    const sellTrigger = lo - pad
    const stopDistance = atr * stopAtr

    if (!(stopDistance > 0)) {
      reasons.push(reason('BAD_STOP', 'Computed stop distance is not positive.', false))
      return { intents, reasons }
    }

    // A range narrower than the stop means the two entries sit inside each
    // other's risk — the setup is incoherent and is refused rather than sized.
    if (buyTrigger - sellTrigger <= 0) {
      reasons.push(reason('BAD_RANGE', 'Range collapsed; triggers would cross.', false))
      return { intents, reasons }
    }

    reasons.push(
      reason('ARM_OCO', `Arming breakout orders around a ${lookback}-bar range.`, true, {
        rangeHigh: hi,
        rangeLow: lo,
        buyTrigger,
        sellTrigger,
        atr,
        session,
      }),
    )

    const timeoutBars = timeout > 0 ? Math.round(timeout) : null

    intents.push({
      kind: 'PLACE',
      side: 'LONG',
      type: 'STOP',
      price: buyTrigger,
      stopLoss: buyTrigger - stopDistance,
      takeProfit: buyTrigger + stopDistance * targetR,
      timeoutBars,
      ocoGroup: GROUP,
      expiresAfterBars: expiry,
      tag: 'breakout_long',
    })
    intents.push({
      kind: 'PLACE',
      side: 'SHORT',
      type: 'STOP',
      price: sellTrigger,
      stopLoss: sellTrigger + stopDistance,
      takeProfit: sellTrigger - stopDistance * targetR,
      timeoutBars,
      ocoGroup: GROUP,
      expiresAfterBars: expiry,
      tag: 'breakout_short',
    })

    return { intents, reasons }
  },
}

export default strategy
