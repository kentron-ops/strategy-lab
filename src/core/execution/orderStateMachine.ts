import type { Candle, IntrabarPolicy, Order, OrderType, Side } from '../types'

/**
 * Order lifecycle: PENDING → FILLED | CANCELLED | EXPIRED | REJECTED.
 * Every transition is recorded on the order itself so the Event Path Explorer
 * can replay exactly what the engine did and why.
 */

export interface TriggerResult {
  triggered: boolean
  /** Raw price before spread/slippage. */
  rawPrice: number
  /** The bar opened past the trigger, so the fill is at the open, not the level. */
  gapped: boolean
}

/**
 * Would this order trigger during `bar`?
 *
 * Gap rule: if the bar OPENS beyond the trigger, the fill happens at the open.
 * For stop orders that is worse than the level (correct — stops gap against you).
 * For limit orders it is better (also correct — limits fill at or better).
 */
export function checkTrigger(
  order: Pick<Order, 'side' | 'type' | 'price'>,
  bar: Candle,
): TriggerResult {
  const { side, type, price } = order

  if (type === 'MARKET') {
    return { triggered: true, rawPrice: bar.o, gapped: false }
  }

  if (type === 'STOP') {
    if (side === 'LONG') {
      if (bar.o >= price) return { triggered: true, rawPrice: bar.o, gapped: true }
      if (bar.h >= price) return { triggered: true, rawPrice: price, gapped: false }
    } else {
      if (bar.o <= price) return { triggered: true, rawPrice: bar.o, gapped: true }
      if (bar.l <= price) return { triggered: true, rawPrice: price, gapped: false }
    }
    return { triggered: false, rawPrice: price, gapped: false }
  }

  // LIMIT
  if (side === 'LONG') {
    if (bar.o <= price) return { triggered: true, rawPrice: bar.o, gapped: true }
    if (bar.l <= price) return { triggered: true, rawPrice: price, gapped: false }
  } else {
    if (bar.o >= price) return { triggered: true, rawPrice: bar.o, gapped: true }
    if (bar.h >= price) return { triggered: true, rawPrice: price, gapped: false }
  }
  return { triggered: false, rawPrice: price, gapped: false }
}

export interface EntrySelection {
  order: Order | null
  trigger: TriggerResult | null
  /** More than one entry could have filled in this bar. */
  ambiguous: boolean
  /** SKIP_AMBIGUOUS declined to take any of them. */
  skipped: boolean
}

/**
 * Choose which pending order actually fills when several trigger in one bar.
 *
 * This matters most for the OCO breakout, where a wide bar can sweep both the
 * buy stop and the sell stop. OHLC cannot say which came first.
 *
 * Resolution: whichever trigger sits closer to the bar's OPEN was more likely
 * touched first, so that one is taken and the fill is flagged ambiguous. Note
 * this is NOT the CONSERVATIVE/OPTIMISTIC axis — for an entry neither direction
 * is inherently adverse, so pretending one is would be a different kind of lie.
 * SKIP_AMBIGUOUS declines the bar entirely.
 */
export function selectEntry(
  pending: Order[],
  bar: Candle,
  policy: IntrabarPolicy,
  currentBar: number,
): EntrySelection {
  const candidates: { order: Order; trigger: TriggerResult }[] = []

  for (const o of pending) {
    if (o.status !== 'PENDING') continue
    // Orders are eligible only from the bar AFTER they were created.
    if (currentBar <= o.createdBar) continue
    const trigger = checkTrigger(o, bar)
    if (trigger.triggered) candidates.push({ order: o, trigger })
  }

  if (!candidates.length) {
    return { order: null, trigger: null, ambiguous: false, skipped: false }
  }
  if (candidates.length === 1) {
    return {
      order: candidates[0].order,
      trigger: candidates[0].trigger,
      ambiguous: false,
      skipped: false,
    }
  }

  if (policy === 'SKIP_AMBIGUOUS') {
    return { order: null, trigger: null, ambiguous: true, skipped: true }
  }

  candidates.sort(
    (a, b) =>
      Math.abs(a.trigger.rawPrice - bar.o) - Math.abs(b.trigger.rawPrice - bar.o),
  )
  return {
    order: candidates[0].order,
    trigger: candidates[0].trigger,
    ambiguous: true,
    skipped: false,
  }
}

/** Expire pending orders that have outlived their bar budget. */
export function expireOrders(pending: Order[], currentBar: number): Order[] {
  const expired: Order[] = []
  for (const o of pending) {
    if (o.status !== 'PENDING') continue
    if (o.expiresAfterBars === null) continue
    if (currentBar - o.createdBar >= o.expiresAfterBars) {
      o.status = 'EXPIRED'
      expired.push(o)
    }
  }
  return expired
}

/** Cancel every other order in the filled order's OCO group. */
export function cancelOcoSiblings(pending: Order[], filled: Order): Order[] {
  if (!filled.ocoGroup) return []
  const cancelled: Order[] = []
  for (const o of pending) {
    if (o.id === filled.id) continue
    if (o.status !== 'PENDING') continue
    if (o.ocoGroup === filled.ocoGroup) {
      o.status = 'CANCELLED'
      cancelled.push(o)
    }
  }
  return cancelled
}

export function cancelGroup(pending: Order[], group: string | null): Order[] {
  const cancelled: Order[] = []
  for (const o of pending) {
    if (o.status !== 'PENDING') continue
    if (group === null || o.ocoGroup === group) {
      o.status = 'CANCELLED'
      cancelled.push(o)
    }
  }
  return cancelled
}

/** Validate an order's geometry before it can enter the book. */
export function validateOrder(
  side: Side,
  type: OrderType,
  price: number,
  stopLoss: number,
  takeProfit: number | null,
): string | null {
  if (!Number.isFinite(price) || price <= 0) return 'Order price is not a positive number.'
  if (!Number.isFinite(stopLoss) || stopLoss <= 0) return 'Stop loss is not a positive number.'
  if (side === 'LONG') {
    if (stopLoss >= price) return 'Long stop loss must sit below the entry price.'
    if (takeProfit !== null && takeProfit <= price) {
      return 'Long take profit must sit above the entry price.'
    }
  } else {
    if (stopLoss <= price) return 'Short stop loss must sit above the entry price.'
    if (takeProfit !== null && takeProfit >= price) {
      return 'Short take profit must sit below the entry price.'
    }
  }
  return null
}
