import type { Decision, Intent, Reason, Strategy, StrategyContext } from '../types'
import { num, reason, sessionAllowed, str } from './helpers'

/**
 * A. SIMULTANEOUS HEDGE — the baseline.
 *
 * Opens a long and a short at the same moment, same stop, same target. This is
 * the idea the whole project started from, and it exists here to be MEASURED,
 * not believed.
 *
 * What the arithmetic already says before any data is loaded: the two legs
 * cancel directionally, so the position's expected gross P&L is zero minus the
 * spread paid twice. Whatever the winner makes, the loser loses, and both legs
 * pay costs. The only way it can profit is if the winner's target is reached
 * while the loser's stop is NOT — i.e. it is a bet on trend continuation wearing
 * a hedge costume, paying double the entry cost for the disguise.
 *
 * The backtester's job is to put a number on that instead of arguing about it.
 * It is the comparison floor every other strategy must beat.
 */

const strategy: Strategy = {
  id: 'simultaneous_hedge',
  name: 'Simultaneous hedge (baseline)',
  description:
    'Opens long and short together at a fixed cadence. Directionally neutral by construction; pays entry costs twice. Used as the floor, not as a candidate.',

  defaults: {
    intervalBars: 48,
    stopAtrMultiple: 1.5,
    targetR: 2,
    timeoutBars: 96,
    sessionFilter: 'ALL',
    minAtr: 0,
  },

  paramSpec: [
    {
      key: 'intervalBars',
      label: 'Bars between entries',
      kind: 'number',
      min: 1,
      max: 500,
      step: 1,
      help: 'How often a new hedged pair is opened. There is no signal here — the cadence is arbitrary on purpose, which is exactly the point of a baseline.',
      sweep: { from: 12, to: 120, step: 12 },
    },
    {
      key: 'stopAtrMultiple',
      label: 'Stop = ATR ×',
      kind: 'number',
      min: 0.1,
      max: 10,
      step: 0.1,
      help: 'Stop distance for both legs, in ATR. This distance is 1R.',
      sweep: { from: 0.5, to: 3, step: 0.25 },
    },
    {
      key: 'targetR',
      label: 'Target (R)',
      kind: 'number',
      min: 0.1,
      max: 20,
      step: 0.1,
      help: 'Take profit as a multiple of the stop distance.',
      sweep: { from: 0.5, to: 5, step: 0.5 },
    },
    {
      key: 'timeoutBars',
      label: 'Timeout (bars)',
      kind: 'number',
      min: 1,
      max: 2000,
      step: 1,
      help: 'Close whatever is left after this many bars. 0 disables the timeout.',
      sweep: { from: 24, to: 240, step: 24 },
    },
    {
      key: 'sessionFilter',
      label: 'Sessions',
      kind: 'choice',
      choices: ['ALL', 'ASIA', 'LONDON', 'NY', 'LONDON,NY'],
      help: 'Restrict entries to these sessions.',
    },
    {
      key: 'minAtr',
      label: 'Minimum ATR',
      kind: 'number',
      min: 0,
      max: 100,
      step: 0.01,
      help: 'Refuse to open when volatility is below this, in price units. 0 disables.',
    },
  ],

  evaluate(ctx: StrategyContext): Decision {
    const reasons: Reason[] = []
    const intents: Intent[] = []

    const interval = Math.max(1, num(ctx, 'intervalBars', 48))
    const stopAtr = num(ctx, 'stopAtrMultiple', 1.5)
    const targetR = num(ctx, 'targetR', 2)
    const timeout = num(ctx, 'timeoutBars', 96)
    const minAtr = num(ctx, 'minAtr', 0)
    const filter = str(ctx, 'sessionFilter', 'ALL')

    const atr = ctx.ind.atr[ctx.i]
    const session = ctx.ind.session[ctx.i]

    if (ctx.positions.length > 0) {
      reasons.push(
        reason('POSITION_OPEN', 'Already holding the hedged pair; waiting for it to resolve.', false),
      )
      return { intents, reasons }
    }

    if (ctx.pendingOrders.some((o) => o.status === 'PENDING')) {
      reasons.push(reason('ORDERS_WORKING', 'Entry orders already working.', false))
      return { intents, reasons }
    }

    if (atr === null) {
      reasons.push(reason('WARMUP', 'ATR has not warmed up yet.', false))
      return { intents, reasons }
    }

    if (ctx.i % interval !== 0) {
      reasons.push(
        reason('OFF_CADENCE', `Not an entry bar (every ${interval} bars).`, false, {
          bar: ctx.i,
        }),
      )
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

    if (minAtr > 0 && atr < minAtr) {
      reasons.push(
        reason('ATR_TOO_LOW', `ATR ${atr.toFixed(4)} is below the minimum ${minAtr}.`, false, {
          atr,
        }),
      )
      return { intents, reasons }
    }

    const stopDistance = atr * stopAtr
    if (!(stopDistance > 0)) {
      reasons.push(reason('BAD_STOP', 'Computed stop distance is not positive.', false))
      return { intents, reasons }
    }

    const price = ctx.candle.c
    const targetDistance = stopDistance * targetR
    const timeoutBars = timeout > 0 ? Math.round(timeout) : null

    reasons.push(
      reason('HEDGE_OPEN', 'Opening both legs. Directionally neutral; pays entry cost twice.', true, {
        atr,
        stopDistance,
        session,
      }),
    )

    // Two independent legs, NOT an OCO pair — both must fill.
    intents.push({
      kind: 'PLACE',
      side: 'LONG',
      type: 'MARKET',
      price,
      stopLoss: price - stopDistance,
      takeProfit: price + targetDistance,
      timeoutBars,
      ocoGroup: null,
      expiresAfterBars: 1,
      tag: 'hedge_long',
    })
    intents.push({
      kind: 'PLACE',
      side: 'SHORT',
      type: 'MARKET',
      price,
      stopLoss: price + stopDistance,
      takeProfit: price - targetDistance,
      timeoutBars,
      ocoGroup: null,
      expiresAfterBars: 1,
      tag: 'hedge_short',
    })

    return { intents, reasons }
  },
}

export default strategy
