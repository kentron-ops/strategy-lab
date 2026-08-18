import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { Candle } from '../types'
import { DEFAULT_INSTRUMENT, DEFAULT_RISK } from '../types'
import { runBacktest } from '../backtest/engine'
import { makeBacktestConfig, makeDataset } from './fixtures'
import { sizePosition } from '../risk/riskEngine'
import { resolveBar } from '../execution/intrabar'
import { computeMetrics } from '../backtest/metrics'
import { validateCandles } from '../data/validators'
import { fnv1a, stableStringify } from '../util/hash'
import { OPTI_CONS_BLOWUP } from './counterexamples/optiConsBlowup'

/**
 * Property-based tests (V2 §6): thousands of randomized inputs asserting the
 * invariants that golden fixtures alone cannot cover. If any of these can be
 * falsified, the engine is lying somewhere.
 *
 * Seeds are deliberately UNPINNED: every run explores fresh inputs. When a
 * run finds a counterexample, the shrunk case gets captured under
 * ./counterexamples and pinned via fc `examples`, so it is exercised forever
 * WITHOUT freezing the rest of the search space.
 */

// 1000-run properties are CPU-heavy; under load (CI cold runners, parallel
// suites on one machine) they can exceed vitest's 5s default timeout and read
// as flakes. A generous explicit budget asserts nothing less — it only stops
// a slow machine from being mistaken for a broken engine.
const LONG = 120_000

// ── generators ──────────────────────────────────────────────────────────────

/** A random but VALID candle series (validators would pass it). */
const candleSeriesArb = (minLen: number, maxLen: number) =>
  fc
    .record({
      seedPrice: fc.double({ min: 50, max: 5000, noNaN: true }),
      steps: fc.array(
        fc.record({
          drift: fc.double({ min: -0.02, max: 0.02, noNaN: true }),
          wickUp: fc.double({ min: 0, max: 0.015, noNaN: true }),
          wickDown: fc.double({ min: 0, max: 0.015, noNaN: true }),
        }),
        { minLength: minLen, maxLength: maxLen },
      ),
    })
    .map(({ seedPrice, steps }) => {
      const start = Date.UTC(2025, 0, 6)
      const out: Candle[] = []
      let price = seedPrice
      steps.forEach((s, i) => {
        const o = price
        const c = Math.max(0.01, o * (1 + s.drift))
        const h = Math.max(o, c) * (1 + s.wickUp)
        const l = Math.min(o, c) * (1 - s.wickDown)
        out.push({
          t: start + i * 300000,
          o: r4(o),
          h: r4(Math.max(h, o, c)),
          l: r4(Math.min(l, o, c)),
          c: r4(c),
          v: 100,
        })
        price = c
      })
      return out
    })

const r4 = (x: number): number => Math.round(x * 10000) / 10000

// ── conservation of money ────────────────────────────────────────────────────

describe('property: conservation of P&L', () => {
  it('ledger sum equals equity change on random data, any strategy, any policy', () => {
    fc.assert(
      fc.property(
        candleSeriesArb(150, 400),
        fc.constantFrom('oco_breakout', 'simultaneous_hedge', 'breakout_continuation'),
        fc.constantFrom('CONSERVATIVE', 'OPTIMISTIC', 'SKIP_AMBIGUOUS' as const),
        (candles, strategyId, intrabar) => {
          const cfg = makeBacktestConfig(
            strategyId,
            {
              intrabar,
              risk: {
                ...DEFAULT_RISK,
                startingEquity: 10_000,
                equityFloorPercent: null,
                maxConcurrentPositions: strategyId === 'simultaneous_hedge' ? 2 : 1,
              },
            },
            strategyId === 'breakout_continuation'
              ? { requireHtfAlignment: false, minAtrPercentile: 0, minRangeExpansion: 0, minBodyRatio: 0, sessionFilter: 'ALL' }
              : {},
          )
          const r = runBacktest(makeDataset(candles), cfg)

          const ledger = r.trades.filter((t) => !t.excluded).reduce((a, t) => a + t.netPnl, 0)
          expect(r.metrics.endingEquity).toBeCloseTo(10_000 + ledger, 6)
          // The engine's own invariant check must not have tripped either.
          expect(r.warnings.filter((w) => w.startsWith('INVARIANT'))).toHaveLength(0)
          // Costs are counted exactly once: net = gross − costs per trade.
          for (const t of r.trades) {
            expect(t.netPnl).toBeCloseTo(t.grossPnl - t.costs, 6)
            expect(t.costs).toBeGreaterThanOrEqual(-1e-9)
          }
        },
      ),
      { numRuns: 1000 },
    )
  }, LONG)
})

// ── sizing never exceeds the configured risk ─────────────────────────────────

describe('property: sizing never risks more than configured', () => {
  it('holds for random equity, prices and stops', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 10, max: 1_000_000, noNaN: true }),
        fc.double({ min: 1, max: 10_000, noNaN: true }),
        fc.double({ min: 0.0001, max: 0.2, noNaN: true }),
        fc.double({ min: 0.1, max: 5, noNaN: true }),
        (equity, price, stopFrac, riskPct) => {
          const stop = price * (1 - stopFrac)
          const s = sizePosition({
            equity,
            entryPrice: price,
            stopLoss: stop,
            side: 'LONG',
            instrument: DEFAULT_INSTRUMENT,
            risk: { ...DEFAULT_RISK, startingEquity: equity, riskPercent: riskPct },
            atr: price * 0.01,
          })
          if (s.ok) {
            // Never more than the budget (tiny epsilon for float dust).
            expect(s.riskAmount).toBeLessThanOrEqual((equity * riskPct) / 100 + 1e-6)
            expect(s.qty).toBeGreaterThan(0)
          }
        },
      ),
      { numRuns: 1000 },
    )
  }, LONG)
})

// ── intrabar policy ordering ─────────────────────────────────────────────────

describe('property: CONSERVATIVE is never better than OPTIMISTIC on the same bar', () => {
  it('for any ambiguous bar, conservative resolves to the stop and optimistic to the target', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 10, max: 1000, noNaN: true }),
        fc.double({ min: 0.001, max: 0.3, noNaN: true }),
        fc.double({ min: 0.001, max: 0.3, noNaN: true }),
        (mid, stopFrac, targetFrac) => {
          const stop = mid * (1 - stopFrac)
          const target = mid * (1 + targetFrac)
          // A bar wide enough to touch both, opening between them.
          const bar: Candle = { t: 0, o: mid, h: target + 1, l: stop - 1, c: mid }
          const levels = { side: 'LONG' as const, stopLoss: stop, takeProfit: target }

          const cons = resolveBar(bar, levels, 'CONSERVATIVE')
          const opti = resolveBar(bar, levels, 'OPTIMISTIC')
          const skip = resolveBar(bar, levels, 'SKIP_AMBIGUOUS')

          expect(cons).toMatchObject({ kind: 'EXIT', reason: 'STOP', ambiguous: true })
          expect(opti).toMatchObject({ kind: 'EXIT', reason: 'TARGET', ambiguous: true })
          expect(skip.kind).toBe('AMBIGUOUS_SKIP')
          // Conservative exit is strictly worse for a long.
          if (cons.kind === 'EXIT' && opti.kind === 'EXIT') {
            expect(cons.price).toBeLessThan(opti.price)
          }
        },
      ),
      { numRuns: 1000 },
    )
  }, LONG)

  it('per matched ambiguous trade, OPTIMISTIC per-unit gross is never below CONSERVATIVE', () => {
    // Previous version compared ENDING EQUITY across the two runs. That was
    // wrong: with fixed-fractional sizing, a better ambiguous outcome grows
    // equity and enlarges the NEXT trade's quantity — which then magnifies
    // whatever happens next, in either direction. Same-entries + same-side
    // does NOT imply same total P&L under equity-fed sizing.
    //
    // The invariant that actually holds, and that the intrabar policy
    // guarantees, is per-trade at per-unit-qty level: for a matched pair of
    // trades entered on the same bar, if one exited ambiguously, OPTIMISTIC
    // must not have made LESS price movement than CONSERVATIVE on that
    // ambiguous exit. That is a property of the policy alone, independent of
    // sizing feedback.
    fc.assert(
      fc.property(candleSeriesArb(150, 350), (candles) => {
        const mk = (intrabar: 'CONSERVATIVE' | 'OPTIMISTIC') =>
          runBacktest(
            makeDataset(candles),
            makeBacktestConfig('oco_breakout', { intrabar }, { targetR: 1, stopAtrMultiple: 1 }),
          )
        const cons = mk('CONSERVATIVE')
        const opti = mk('OPTIMISTIC')

        const n = Math.min(cons.trades.length, opti.trades.length)
        for (let i = 0; i < n; i++) {
          const c = cons.trades[i]
          const o = opti.trades[i]
          if (c.entryBar !== o.entryBar) break // once divergence starts, later pairs are unrelated
          if (c.side !== o.side) break
          // Only relevant when at least one of the two matched exits was ambiguous.
          if (!c.ambiguous && !o.ambiguous) continue
          const sign = c.side === 'LONG' ? 1 : -1
          const cGrossPerUnit = sign * (c.exitPrice - c.entryPrice)
          const oGrossPerUnit = sign * (o.exitPrice - o.entryPrice)
          expect(oGrossPerUnit).toBeGreaterThanOrEqual(cGrossPerUnit - 1e-6)
        }
      }),
      {
        numRuns: 1000,
        // Regression case captured on a live property run — see the
        // counterexamples file for its provenance.
        examples: [[OPTI_CONS_BLOWUP]],
      },
    )
  }, LONG)
})

// ── metrics on random ledgers ────────────────────────────────────────────────

describe('property: metrics never produce NaN and respect identities', () => {
  it('for any random trade ledger', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -500, max: 500, noNaN: true }), { minLength: 0, maxLength: 200 }),
        (pnls) => {
          const trades = pnls.map((p, i) => ({
            id: `t${i}`, strategyId: 's', side: 'LONG' as const, qty: 1, tag: '',
            entryBar: i * 2, entryTime: i * 600000, entryPrice: 100,
            exitBar: i * 2 + 1, exitTime: i * 600000 + 300000, exitPrice: 100,
            stopLoss: 95, takeProfit: null, rDistance: 5, riskAmount: 100,
            exitReason: 'STOP' as const, grossPnl: p, costs: 0, netPnl: p, r: p / 100,
            mfeR: 0, maeR: 0, barsHeld: 1, holdingMs: 300000,
            ambiguous: false, excluded: false,
            session: 'LONDON' as const, regime: { vol: 'MID_VOL' as const, trend: 'RANGING' as const },
            equityAfter: 0, reasons: [],
          }))
          const m = computeMetrics(trades, [], 1000, { barsInPosition: 1, totalBars: 10 })
          for (const [k, v] of Object.entries(m)) {
            if (typeof v === 'number') expect(Number.isNaN(v), `${k} is NaN`).toBe(false)
          }
          expect(m.wins + m.losses + m.breakEven).toBe(trades.length)
          expect(m.netPnl).toBeCloseTo(pnls.reduce((a, b) => a + b, 0), 6)
          if (trades.length) {
            expect(m.winRate.point).toBeGreaterThanOrEqual(0)
            expect(m.winRate.point).toBeLessThanOrEqual(1)
            expect(m.winRate.low).toBeLessThanOrEqual(m.winRate.point + 1e-12)
            expect(m.winRate.high).toBeGreaterThanOrEqual(m.winRate.point - 1e-12)
          }
        },
      ),
      { numRuns: 1000 },
    )
  }, LONG)
})

// ── validators accept what the generator builds ──────────────────────────────

describe('property: generated candles are always valid, and hashing is stable', () => {
  it('validator passes and hash is order-of-keys independent', () => {
    fc.assert(
      fc.property(candleSeriesArb(10, 60), (candles) => {
        const q = validateCandles(candles, '5m')
        expect(q.usable).toBe(true)

        const a = { x: 1, y: { b: 2, a: 3 }, z: [1, 2] }
        const b = { z: [1, 2], y: { a: 3, b: 2 }, x: 1 }
        expect(fnv1a(stableStringify(a))).toBe(fnv1a(stableStringify(b)))
      }),
      { numRuns: 50 },
    )
  })
})

// ── determinism ──────────────────────────────────────────────────────────────

describe('property: the engine is a pure function of its inputs', () => {
  it('same inputs give byte-identical results on random data', () => {
    fc.assert(
      fc.property(candleSeriesArb(120, 250), (candles) => {
        const ds = makeDataset(candles)
        const cfg = makeBacktestConfig('oco_breakout')
        const a = runBacktest(ds, cfg)
        const b = runBacktest(ds, cfg)
        expect(JSON.stringify(b.trades)).toBe(JSON.stringify(a.trades))
        expect(JSON.stringify(b.metrics)).toBe(JSON.stringify(a.metrics))
      }),
      { numRuns: 1000 },
    )
  }, LONG)
})
