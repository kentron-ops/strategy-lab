import { describe, expect, it } from 'vitest'
import { runBacktest } from './engine'
import { makeDataset, makeFrictionlessConfig } from '../testing/fixtures'
import { getStrategy, registerStrategy } from '../strategy/registry'
import type { Candle, Strategy, StrategyConfig } from '../types'
import { DEFAULT_COSTS, DEFAULT_INDICATORS, DEFAULT_INSTRUMENT, DEFAULT_RISK } from '../types'

/**
 * Golden fixtures — hand-computable scenarios.
 *
 * Each test constructs a tiny bar series where every trade's outcome can be
 * derived on paper from OHLC alone. If the engine ever drifts from the
 * arithmetic here, one of these tests will catch it before the property
 * suite does.
 *
 * Every case uses a purpose-built "fire-once" strategy that places a single
 * MARKET entry on bar 1, with an explicit stop and target in price units, so
 * the fill, exit and P&L are exactly predictable.
 *
 * Convention for every bar is `{o, h, l, c}`; the strategy's fill is the
 * OPEN of bar 2 (orders placed on bar 1 become eligible on bar 2, and MARKET
 * fills at the open).
 */

// ── one-shot strategy factory (registers with the engine registry) ───────────

interface OneShot {
  id: string
  side: 'LONG' | 'SHORT'
  stopPrice: number
  targetPrice: number
  entryBar: number
}

function makeOneShot(opts: OneShot): Strategy {
  const s: Strategy = {
    id: opts.id,
    name: opts.id,
    description: 'golden-fixture one-shot',
    defaults: {},
    paramSpec: [],
    evaluate(ctx) {
      if (ctx.i !== opts.entryBar) {
        return { intents: [], reasons: [{ code: 'WAIT', message: 'wait', passed: false }] }
      }
      if (ctx.positions.length || ctx.pendingOrders.some((o) => o.status === 'PENDING')) {
        return { intents: [], reasons: [{ code: 'BUSY', message: 'busy', passed: false }] }
      }
      return {
        reasons: [{ code: 'FIRE', message: 'fire', passed: true }],
        intents: [
          {
            kind: 'PLACE',
            side: opts.side,
            type: 'MARKET',
            price: ctx.candle.c,
            stopLoss: opts.stopPrice,
            takeProfit: opts.targetPrice,
            timeoutBars: null,
            ocoGroup: null,
            expiresAfterBars: 1,
            tag: 'golden',
          },
        ],
      }
    },
  }
  registerStrategy(s)
  return s
}

function frictionlessOneShotConfig(strategyId: string): StrategyConfig {
  return {
    id: `cfg_${strategyId}`,
    strategyId,
    name: strategyId,
    params: {},
    lockedAt: null,
    forwardTestFrom: null,
    version: 1,
    createdAt: 0,
  }
}

const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c, v: 100 })

// ── 1. Winning LONG at target, zero costs ──────────────────────────────────

describe('golden: winning LONG hits target, zero costs', () => {
  it('R = +2 exactly, P&L per unit = (target − entry)', () => {
    // Entry at bar 1 open (bar 0 close = 100). Order placed on bar 1, fills at
    // bar 2 open = 100. Stop 95 → R = 5. Target 110. Bar 3 high 110 = target hit.
    const candles = [
      bar(0, 99, 100, 99, 100),
      bar(300000, 100, 100.5, 99.5, 100),   // strategy fires here (i=1), MARKET order
      bar(600000, 100, 105, 100, 105),      // bar 2: fill at open 100
      bar(900000, 105, 110, 104, 108),      // bar 3: high 110 = target
    ]
    makeOneShot({ id: 'gold_long_win', side: 'LONG', stopPrice: 95, targetPrice: 110, entryBar: 1 })
    const cfg = makeFrictionlessConfig('oco_breakout')
    cfg.strategy = frictionlessOneShotConfig('gold_long_win')
    const r = runBacktest(makeDataset(candles), cfg)

    expect(r.trades).toHaveLength(1)
    const t = r.trades[0]
    expect(t.entryPrice).toBeCloseTo(100, 10)
    expect(t.exitPrice).toBeCloseTo(110, 10)
    expect(t.exitReason).toBe('TARGET')
    expect(t.rDistance).toBeCloseTo(5, 10)
    expect(t.r).toBeCloseTo(2, 10)
    expect(t.grossPnl).toBeCloseTo(10 * t.qty, 8) // (110 − 100) × qty
    expect(t.netPnl).toBeCloseTo(10 * t.qty, 8)
    expect(t.costs).toBeCloseTo(0, 12)
  })
})

// ── 2. Losing LONG at stop, zero costs ─────────────────────────────────────

describe('golden: losing LONG hits stop, zero costs', () => {
  it('R = −1 exactly', () => {
    const candles = [
      bar(0, 101, 101, 100, 100),
      bar(300000, 100, 100.5, 99.5, 100),   // i=1 fires
      bar(600000, 100, 100.5, 99, 99),      // i=2 fill at open 100
      bar(900000, 99, 99, 94, 95),          // i=3 low 94 hits stop 95
    ]
    makeOneShot({ id: 'gold_long_lose', side: 'LONG', stopPrice: 95, targetPrice: 120, entryBar: 1 })
    const cfg = makeFrictionlessConfig('oco_breakout')
    cfg.strategy = frictionlessOneShotConfig('gold_long_lose')
    const r = runBacktest(makeDataset(candles), cfg)

    const t = r.trades[0]
    expect(t.exitReason).toBe('STOP')
    expect(t.exitPrice).toBeCloseTo(95, 10)
    expect(t.r).toBeCloseTo(-1, 10)
    expect(t.grossPnl).toBeCloseTo(-5 * t.qty, 8)
    expect(t.netPnl).toBeCloseTo(-5 * t.qty, 8)
  })
})

// ── 3. Winning SHORT at target ────────────────────────────────────────────

describe('golden: winning SHORT hits target', () => {
  it('R = +1 exactly, P&L per unit = (entry − target)', () => {
    const candles = [
      bar(0, 101, 101, 100, 100),
      bar(300000, 100, 100.5, 99.5, 100),   // i=1 fires SHORT
      bar(600000, 100, 100, 99, 99),        // i=2 fill at open 100
      bar(900000, 99, 99, 89, 90),          // i=3 low 89 → target 90 hit
    ]
    makeOneShot({ id: 'gold_short_win', side: 'SHORT', stopPrice: 110, targetPrice: 90, entryBar: 1 })
    const cfg = makeFrictionlessConfig('oco_breakout')
    cfg.strategy = frictionlessOneShotConfig('gold_short_win')
    const r = runBacktest(makeDataset(candles), cfg)

    const t = r.trades[0]
    expect(t.side).toBe('SHORT')
    expect(t.exitReason).toBe('TARGET')
    expect(t.entryPrice).toBeCloseTo(100, 10)
    expect(t.exitPrice).toBeCloseTo(90, 10)
    expect(t.rDistance).toBeCloseTo(10, 10)
    expect(t.r).toBeCloseTo(1, 10)
    expect(t.grossPnl).toBeCloseTo(10 * t.qty, 8)
    expect(t.netPnl).toBeCloseTo(10 * t.qty, 8)
  })
})

// ── 4. Losing SHORT at stop ───────────────────────────────────────────────

describe('golden: losing SHORT hits stop', () => {
  it('R = −1 exactly', () => {
    const candles = [
      bar(0, 99, 100, 99, 100),
      bar(300000, 100, 100.5, 99.5, 100),   // i=1 fires SHORT
      bar(600000, 100, 101, 100, 101),      // i=2 fill at open 100
      bar(900000, 101, 106, 100, 105),      // i=3 high 106 → stop 105
    ]
    makeOneShot({ id: 'gold_short_lose', side: 'SHORT', stopPrice: 105, targetPrice: 80, entryBar: 1 })
    const cfg = makeFrictionlessConfig('oco_breakout')
    cfg.strategy = frictionlessOneShotConfig('gold_short_lose')
    const r = runBacktest(makeDataset(candles), cfg)

    const t = r.trades[0]
    expect(t.exitReason).toBe('STOP')
    expect(t.entryPrice).toBeCloseTo(100, 10)
    expect(t.exitPrice).toBeCloseTo(105, 10)
    expect(t.r).toBeCloseTo(-1, 10)
    expect(t.grossPnl).toBeCloseTo(-5 * t.qty, 8)
  })
})

// ── 5. Spread pays out of every fill ───────────────────────────────────────

describe('golden: spread costs both entry and exit', () => {
  it('net = gross − spread on both sides', () => {
    // MARKET entry pays half spread on the way in, target exit pays half spread
    // on the way out. Full-round-trip spread cost per unit = spread.
    const candles = [
      bar(0, 99, 100, 99, 100),
      bar(300000, 100, 100.5, 99.5, 100),
      bar(600000, 100, 105, 100, 105),
      bar(900000, 105, 110, 104, 108),      // target 110 hit
    ]
    makeOneShot({ id: 'gold_spread', side: 'LONG', stopPrice: 95, targetPrice: 110, entryBar: 1 })
    const cfg = makeFrictionlessConfig('oco_breakout')
    cfg.costs = { ...cfg.costs, spread: 0.4, sessionSpreadMultiplier: { ASIA: 1, LONDON: 1, NY: 1, OFF: 1 } }
    cfg.strategy = frictionlessOneShotConfig('gold_spread')
    const r = runBacktest(makeDataset(candles), cfg)

    const t = r.trades[0]
    // Entry fill = 100 + spread/2 = 100.2
    // Target exit fill = 110 − spread/2 = 109.8   (target is a LIMIT exit → no slippage)
    // Per-unit net gross-flow = 109.8 − 100.2 = 9.6
    expect(t.entryPrice).toBeCloseTo(100.2, 10)
    expect(t.exitPrice).toBeCloseTo(109.8, 10)
    // engine's t.grossPnl is priced from raw levels (entry-to-exit, no costs)
    // and t.netPnl subtracts spread+slippage. Round-trip spread = 0.4 × qty.
    expect(t.grossPnl - t.netPnl).toBeCloseTo(0.4 * t.qty, 8)
    expect(t.costs).toBeCloseTo(0.4 * t.qty, 8)
  })
})

// ── 6. Commission adds a per-unit cost per side ────────────────────────────

describe('golden: commission is per unit per side', () => {
  it('total commission = 2 × commPerUnit × qty', () => {
    const candles = [
      bar(0, 99, 100, 99, 100),
      bar(300000, 100, 100.5, 99.5, 100),
      bar(600000, 100, 105, 100, 105),
      bar(900000, 105, 110, 104, 108),
    ]
    makeOneShot({ id: 'gold_comm', side: 'LONG', stopPrice: 95, targetPrice: 110, entryBar: 1 })
    const cfg = makeFrictionlessConfig('oco_breakout')
    cfg.costs = { ...cfg.costs, commissionPerUnit: 0.05 }
    cfg.strategy = frictionlessOneShotConfig('gold_comm')
    const r = runBacktest(makeDataset(candles), cfg)

    const t = r.trades[0]
    // Frictionless everywhere else so costs == commissions == 2 × 0.05 × qty
    expect(t.costs).toBeCloseTo(2 * 0.05 * t.qty, 8)
    expect(t.netPnl).toBeCloseTo(t.grossPnl - 2 * 0.05 * t.qty, 8)
  })
})

// ── 7. Slippage on a stop exit (adverse), not on a limit exit ─────────────

describe('golden: slippage applies to stop exits, not limit exits', () => {
  it('stopped-out trade fills slippage-worse than the level; target fill does not slip', () => {
    // Two setups: same series, one stops out (slippage applies), the other
    // targets (slippage does NOT apply). Compare the two trades' costs.
    const stopSeries = [
      bar(0, 101, 101, 100, 100),
      bar(300000, 100, 100.5, 99.5, 100),
      bar(600000, 100, 100.5, 99, 99),
      bar(900000, 99, 99, 94, 95),           // stop 95 hit
    ]
    const targetSeries = [
      bar(0, 99, 100, 99, 100),
      bar(300000, 100, 100.5, 99.5, 100),
      bar(600000, 100, 105, 100, 105),
      bar(900000, 105, 110, 104, 108),       // target 110 hit
    ]
    // Both use MARKET entry so entry slippage/spread land the same way; only
    // the EXIT differs (STOP vs TARGET).
    makeOneShot({ id: 'gold_slip_stop', side: 'LONG', stopPrice: 95, targetPrice: 200, entryBar: 1 })
    makeOneShot({ id: 'gold_slip_tp', side: 'LONG', stopPrice: 50, targetPrice: 110, entryBar: 1 })

    const mkCfg = (stratId: string) => {
      const c = makeFrictionlessConfig('oco_breakout')
      c.costs = { ...c.costs, slippage: 0.2 }
      c.strategy = frictionlessOneShotConfig(stratId)
      return c
    }
    const stop = runBacktest(makeDataset(stopSeries), mkCfg('gold_slip_stop')).trades[0]
    const tp = runBacktest(makeDataset(targetSeries), mkCfg('gold_slip_tp')).trades[0]

    // Stop exit: fill = stop − slippage = 95 − 0.2 = 94.8
    expect(stop.exitReason).toBe('STOP')
    expect(stop.exitPrice).toBeCloseTo(94.8, 10)
    // Target exit: fill = target exactly (spread=0 and LIMIT does not slip)
    expect(tp.exitReason).toBe('TARGET')
    expect(tp.exitPrice).toBeCloseTo(110, 10)
    // Per-unit cost breakdown:
    //   stop path: MARKET entry pays slippage (0.2) + stop exit pays slippage (0.2) = 0.4
    //   target path: MARKET entry pays slippage (0.2) + LIMIT target does NOT slip = 0.2
    // So the DIFFERENCE (stop − target) is exactly the 0.2 that limits save.
    expect(stop.costs / stop.qty).toBeCloseTo(0.4, 10)
    expect(tp.costs / tp.qty).toBeCloseTo(0.2, 10)
    expect((stop.costs / stop.qty) - (tp.costs / tp.qty)).toBeCloseTo(0.2, 10)
  })
})

// ── 8. Round-trip accounting under COMBINED costs ─────────────────────────

describe('golden: spread + commission + slippage combine additively per trade', () => {
  it('total cost = spread + slippage + 2 × commission (per unit, times qty)', () => {
    const candles = [
      bar(0, 101, 101, 100, 100),
      bar(300000, 100, 100.5, 99.5, 100),
      bar(600000, 100, 100.5, 99, 99),
      bar(900000, 99, 99, 94, 95),
    ]
    makeOneShot({ id: 'gold_all', side: 'LONG', stopPrice: 95, targetPrice: 200, entryBar: 1 })
    const cfg = makeFrictionlessConfig('oco_breakout')
    cfg.costs = {
      ...cfg.costs,
      spread: 0.4,
      slippage: 0.2,
      commissionPerUnit: 0.05,
      sessionSpreadMultiplier: { ASIA: 1, LONDON: 1, NY: 1, OFF: 1 },
    }
    cfg.strategy = frictionlessOneShotConfig('gold_all')
    const r = runBacktest(makeDataset(candles), cfg)

    const t = r.trades[0]
    // Expected per-unit round-trip cost:
    //   spread (0.4) + slippage on stop exit only (0.2) + 2 × commission (0.10) = 0.70
    // MARKET entry pays slippage too — so add another 0.2 on entry:
    //   spread (0.4) + entry slip (0.2) + exit slip (0.2) + 2 × 0.05 = 0.90
    const expectedCostPerUnit = 0.4 /* spread round-trip */ + 0.2 + 0.2 + 2 * 0.05
    expect(t.costs / t.qty).toBeCloseTo(expectedCostPerUnit, 8)
    // And net still equals gross − costs.
    expect(t.netPnl).toBeCloseTo(t.grossPnl - t.costs, 8)
  })
})

// ── 9. Multi-trade ledger reconciles to ending equity ─────────────────────

describe('golden: multi-trade ledger reconciles to ending equity', () => {
  it('starting equity + Σ trade.netPnl == ending equity', () => {
    // Three targets in a row on the same simple pattern (using a 3-shot
    // strategy). We assemble bars so exits happen cleanly.
    const period = 300000
    const c: Candle[] = []
    let t0 = 0
    for (let k = 0; k < 3; k++) {
      // Each 4-bar block: entry, fill, target
      c.push(bar(t0, 99, 100, 99, 100)); t0 += period
      c.push(bar(t0, 100, 100.5, 99.5, 100)); t0 += period  // strategy fires here
      c.push(bar(t0, 100, 105, 100, 105)); t0 += period    // MARKET fill at open 100
      c.push(bar(t0, 105, 110, 104, 108)); t0 += period    // target 110 hit
    }
    // Custom multi-shot strategy: fires on bars 1, 5, 9
    const stratId = 'gold_multi'
    const s: Strategy = {
      id: stratId,
      name: stratId,
      description: 'multi',
      defaults: {},
      paramSpec: [],
      evaluate(ctx) {
        const fireBars = new Set([1, 5, 9])
        if (!fireBars.has(ctx.i)) return { intents: [], reasons: [] }
        if (ctx.positions.length) return { intents: [], reasons: [] }
        return {
          reasons: [{ code: 'FIRE', message: 'fire', passed: true }],
          intents: [
            {
              kind: 'PLACE',
              side: 'LONG',
              type: 'MARKET',
              price: ctx.candle.c,
              stopLoss: 95,
              takeProfit: 110,
              timeoutBars: null,
              ocoGroup: null,
              expiresAfterBars: 1,
              tag: 'multi',
            },
          ],
        }
      },
    }
    registerStrategy(s)

    const cfg = makeFrictionlessConfig('oco_breakout')
    cfg.strategy = frictionlessOneShotConfig(stratId)
    const r = runBacktest(makeDataset(c), cfg)

    expect(r.trades).toHaveLength(3)
    const ledgerSum = r.trades.reduce((a, tr) => a + tr.netPnl, 0)
    expect(r.metrics.endingEquity).toBeCloseTo(cfg.risk.startingEquity + ledgerSum, 6)
    // And every single trade is exactly +2R
    for (const tr of r.trades) {
      expect(tr.r).toBeCloseTo(2, 10)
    }
    // And the engine's runtime invariant never tripped
    expect(r.warnings.filter((w) => w.startsWith('INVARIANT'))).toHaveLength(0)
  })
})

// Suppress "the strategy makeOneShot registered a bunch of ids" warnings by
// making sure the registry doesn't leak between tests. We don't clean it —
// each id is unique and only affects lookup.
void getStrategy
void DEFAULT_COSTS
void DEFAULT_INDICATORS
void DEFAULT_INSTRUMENT
void DEFAULT_RISK
