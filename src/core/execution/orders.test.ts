import { describe, expect, it } from 'vitest'
import type { Candle, Order } from '../types'
import {
  cancelOcoSiblings,
  checkTrigger,
  expireOrders,
  selectEntry,
  validateOrder,
} from './orderStateMachine'
import { fillPrice, roundTripCostInPrice } from './costModel'
import { DEFAULT_COSTS } from '../types'

const bar = (o: number, h: number, l: number, c: number): Candle => ({ t: 0, o, h, l, c })

const order = (over: Partial<Order> = {}): Order => ({
  id: 'o1',
  side: 'LONG',
  type: 'STOP',
  price: 105,
  stopLoss: 100,
  takeProfit: 115,
  timeoutBars: null,
  ocoGroup: null,
  createdBar: 0,
  expiresAfterBars: null,
  status: 'PENDING',
  filledBar: null,
  filledPrice: null,
  qty: 0,
  tag: 'test',
  reasons: [],
  ...over,
})

describe('trigger detection', () => {
  it('a buy stop triggers when the high reaches it', () => {
    expect(checkTrigger({ side: 'LONG', type: 'STOP', price: 105 }, bar(100, 106, 99, 104)))
      .toMatchObject({ triggered: true, rawPrice: 105, gapped: false })
    expect(checkTrigger({ side: 'LONG', type: 'STOP', price: 105 }, bar(100, 104, 99, 103)))
      .toMatchObject({ triggered: false })
  })

  it('a buy stop that gaps fills at the open, worse than the trigger', () => {
    const t = checkTrigger({ side: 'LONG', type: 'STOP', price: 105 }, bar(108, 110, 107, 109))
    expect(t).toMatchObject({ triggered: true, rawPrice: 108, gapped: true })
    expect(t.rawPrice).toBeGreaterThan(105)
  })

  it('a sell stop that gaps fills at the open, also worse', () => {
    const t = checkTrigger({ side: 'SHORT', type: 'STOP', price: 95 }, bar(92, 93, 90, 91))
    expect(t).toMatchObject({ triggered: true, rawPrice: 92, gapped: true })
    expect(t.rawPrice).toBeLessThan(95)
  })

  it('a buy limit that gaps fills at the open, BETTER than the trigger', () => {
    const t = checkTrigger({ side: 'LONG', type: 'LIMIT', price: 95 }, bar(92, 94, 90, 93))
    expect(t).toMatchObject({ triggered: true, rawPrice: 92, gapped: true })
    expect(t.rawPrice).toBeLessThan(95)
  })

  it('a market order fills at the open', () => {
    expect(checkTrigger({ side: 'LONG', type: 'MARKET', price: 0 }, bar(101, 106, 99, 104)))
      .toMatchObject({ triggered: true, rawPrice: 101 })
  })
})

describe('entry selection', () => {
  it('ignores orders created on the current bar', () => {
    const pending = [order({ createdBar: 5 })]
    const sel = selectEntry(pending, bar(100, 110, 99, 108), 'CONSERVATIVE', 5)
    expect(sel.order).toBeNull()

    const next = selectEntry(pending, bar(100, 110, 99, 108), 'CONSERVATIVE', 6)
    expect(next.order?.id).toBe('o1')
  })

  it('when a wide bar sweeps both OCO sides, it flags ambiguity', () => {
    const pending = [
      order({ id: 'buy', side: 'LONG', type: 'STOP', price: 105, ocoGroup: 'g' }),
      order({ id: 'sell', side: 'SHORT', type: 'STOP', price: 95, stopLoss: 100, takeProfit: 85, ocoGroup: 'g' }),
    ]
    const sel = selectEntry(pending, bar(100, 112, 88, 90), 'CONSERVATIVE', 1)
    expect(sel.ambiguous).toBe(true)
    expect(sel.order).not.toBeNull()
  })

  it('resolves that ambiguity by proximity to the open, not by which is profitable', () => {
    const pending = [
      order({ id: 'buy', side: 'LONG', type: 'STOP', price: 105, ocoGroup: 'g' }),
      order({ id: 'sell', side: 'SHORT', type: 'STOP', price: 80, stopLoss: 100, takeProfit: 60, ocoGroup: 'g' }),
    ]
    // Open 100: the buy stop at 105 is 5 away, the sell stop at 80 is 20 away.
    const sel = selectEntry(pending, bar(100, 112, 78, 79), 'CONSERVATIVE', 1)
    expect(sel.order?.id).toBe('buy')
  })

  it('SKIP_AMBIGUOUS takes neither side', () => {
    const pending = [
      order({ id: 'buy', side: 'LONG', type: 'STOP', price: 105, ocoGroup: 'g' }),
      order({ id: 'sell', side: 'SHORT', type: 'STOP', price: 95, stopLoss: 100, takeProfit: 85, ocoGroup: 'g' }),
    ]
    const sel = selectEntry(pending, bar(100, 112, 88, 90), 'SKIP_AMBIGUOUS', 1)
    expect(sel.order).toBeNull()
    expect(sel.skipped).toBe(true)
    expect(sel.ambiguous).toBe(true)
  })
})

describe('order lifecycle', () => {
  it('cancels OCO siblings on fill and leaves unrelated orders alone', () => {
    const a = order({ id: 'a', ocoGroup: 'g' })
    const b = order({ id: 'b', ocoGroup: 'g' })
    const c = order({ id: 'c', ocoGroup: 'other' })
    const cancelled = cancelOcoSiblings([a, b, c], a)
    expect(cancelled.map((o) => o.id)).toEqual(['b'])
    expect(b.status).toBe('CANCELLED')
    expect(c.status).toBe('PENDING')
  })

  it('expires orders that outlive their bar budget', () => {
    const o = order({ createdBar: 10, expiresAfterBars: 5 })
    expect(expireOrders([o], 14)).toHaveLength(0)
    expect(expireOrders([o], 15)).toHaveLength(1)
    expect(o.status).toBe('EXPIRED')
  })
})

describe('order validation', () => {
  it('rejects a long whose stop sits above the entry', () => {
    expect(validateOrder('LONG', 'STOP', 100, 105, 120)).toMatch(/below the entry/)
  })
  it('rejects a short whose stop sits below the entry', () => {
    expect(validateOrder('SHORT', 'STOP', 100, 95, 80)).toMatch(/above the entry/)
  })
  it('rejects a target on the wrong side', () => {
    expect(validateOrder('LONG', 'STOP', 100, 95, 90)).toMatch(/take profit/)
  })
  it('accepts coherent geometry', () => {
    expect(validateOrder('LONG', 'STOP', 100, 95, 110)).toBeNull()
    expect(validateOrder('SHORT', 'STOP', 100, 105, 90)).toBeNull()
  })
})

describe('cost model', () => {
  const ctx = { atr: 1, session: 'LONDON' as const }

  it('always moves the fill against you on entry', () => {
    const long = fillPrice(100, 'LONG', 'STOP_ENTRY', DEFAULT_COSTS, ctx)
    const short = fillPrice(100, 'SHORT', 'STOP_ENTRY', DEFAULT_COSTS, ctx)
    expect(long).toBeGreaterThan(100)
    expect(short).toBeLessThan(100)
  })

  it('always moves the fill against you on exit', () => {
    const longExit = fillPrice(110, 'LONG', 'STOP_EXIT', DEFAULT_COSTS, ctx)
    const shortExit = fillPrice(90, 'SHORT', 'STOP_EXIT', DEFAULT_COSTS, ctx)
    expect(longExit).toBeLessThan(110)
    expect(shortExit).toBeGreaterThan(90)
  })

  it('a resting limit exit pays the spread but does not slip', () => {
    const limit = fillPrice(110, 'LONG', 'LIMIT_EXIT', DEFAULT_COSTS, ctx)
    const stop = fillPrice(110, 'LONG', 'STOP_EXIT', DEFAULT_COSTS, ctx)
    expect(limit).toBeGreaterThan(stop)
    expect(limit).toBeLessThan(110)
  })

  it('is symmetric between long and short, so neither direction is quietly favoured', () => {
    const longCost = fillPrice(100, 'LONG', 'STOP_ENTRY', DEFAULT_COSTS, ctx) - 100
    const shortCost = 100 - fillPrice(100, 'SHORT', 'STOP_ENTRY', DEFAULT_COSTS, ctx)
    expect(longCost).toBeCloseTo(shortCost, 12)
  })

  it('widens the spread in the sessions configured to be expensive', () => {
    const london = roundTripCostInPrice(DEFAULT_COSTS, { atr: 1, session: 'LONDON' })
    const off = roundTripCostInPrice(DEFAULT_COSTS, { atr: 1, session: 'OFF' })
    expect(off).toBeGreaterThan(london)
  })

  it('scales with ATR when configured to', () => {
    const cfg = { ...DEFAULT_COSTS, spreadMode: 'ATR_SCALED' as const, spreadAtrMultiple: 0.1 }
    const quiet = roundTripCostInPrice(cfg, { atr: 1, session: 'LONDON' })
    const wild = roundTripCostInPrice(cfg, { atr: 10, session: 'LONDON' })
    expect(wild).toBeGreaterThan(quiet)
  })
})
