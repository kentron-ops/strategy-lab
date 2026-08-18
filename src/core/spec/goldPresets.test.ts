import { describe, expect, it } from 'vitest'
import {
  PRESET_GOLD_MEANREV_BB_CCI,
  PRESET_GOLD_MEANREV_BB_CCI_MFI,
  PRESET_GOLD_MOMENTUM,
} from './presets'
import { validateSpec, specIsRunnable } from './validate'
import { makeSpecConfig } from './resolve'
import { runBacktest } from '../backtest/engine'
import { makeBacktestConfig, makeDataset } from '../testing/fixtures'
import { buildSampleDataset } from '../data/sample'
import { bollinger } from '../indicators'
import type { StrategySpec } from './types'

/**
 * The gold presets, tested against the engine rather than against hope.
 *
 * These assert MECHANICS — that the rules fire when they should, that the
 * dynamic Bollinger-middle target lands where it should, that adding MFI can
 * only reduce the trade count. They deliberately assert nothing about
 * profitability: whether these ideas make money is what the Prover is for,
 * and baking a P&L expectation into a unit test would be exactly the
 * self-deception this project exists to prevent.
 */

// A real-ish gold series — the synthetic sample, resampled expectations aside.
const dataset = (() => {
  const full = buildSampleDataset()
  return { ...full, candles: full.candles.slice(0, 6000) }
})()

function cfgFor(spec: StrategySpec) {
  const base = makeBacktestConfig('oco_breakout')
  return { ...base, strategy: makeSpecConfig(spec) }
}

describe('gold presets: validity', () => {
  const all = [PRESET_GOLD_MEANREV_BB_CCI, PRESET_GOLD_MEANREV_BB_CCI_MFI, PRESET_GOLD_MOMENTUM]

  it('every gold preset validates', () => {
    for (const p of all) {
      const issues = validateSpec(p)
      expect(specIsRunnable(issues), `${p.id}: ${JSON.stringify(issues)}`).toBe(true)
    }
  })

  it('every gold preset survives JSON round-trip', () => {
    for (const p of all) expect(JSON.parse(JSON.stringify(p))).toEqual(p)
  })

  it('all three are M30 gold, both directions where intended', () => {
    for (const p of all) {
      expect(p.market).toBe('XAUUSD')
      expect(p.timeframe).toBe('30m')
      expect(p.direction).toBe('both')
    }
  })
})

describe('gold mean reversion (BB+CCI)', () => {
  const spec = PRESET_GOLD_MEANREV_BB_CCI

  it('has the exact rules the brief asked for', () => {
    // LONG: close < lowerBB(20,2) AND CCI(20) < −100
    const longRules = spec.entry.rules
    expect(longRules).toHaveLength(2)
    expect(longRules[0]).toMatchObject({
      cmp: 'LT',
      left: { type: 'price', field: 'close' },
      right: { type: 'bollinger', period: 20, stdDevs: 2, band: 'lower' },
    })
    expect(longRules[1]).toMatchObject({
      cmp: 'LT',
      left: { type: 'cci', period: 20 },
      right: { type: 'value', value: -100 },
    })

    // SHORT is the exact mirror.
    const shortRules = spec.entryShort!.rules
    expect(shortRules[0]).toMatchObject({
      cmp: 'GT',
      right: { type: 'bollinger', period: 20, stdDevs: 2, band: 'upper' },
    })
    expect(shortRules[1]).toMatchObject({ cmp: 'GT', right: { type: 'value', value: 100 } })
  })

  it('stops at 1.5 ATR, targets the Bollinger middle, times out at 16 bars', () => {
    expect(spec.exit.stop).toMatchObject({ unit: 'ATR', value: 1.5 })
    expect(spec.exit.target).toMatchObject({
      unit: 'INDICATOR',
      operand: { type: 'bollinger', period: 20, stdDevs: 2, band: 'middle' },
    })
    expect(spec.exit.timeoutBars).toBe(16)
  })

  it('trades, and every trade obeys the mean-reversion geometry', () => {
    const r = runBacktest(dataset, cfgFor(spec))
    expect(r.trades.length).toBeGreaterThan(0)

    for (const t of r.trades) {
      if (t.side === 'LONG') {
        // Long fades a dip: stop below entry, target above it.
        expect(t.stopLoss).toBeLessThan(t.entryPrice)
        if (t.takeProfit !== null) expect(t.takeProfit).toBeGreaterThan(t.entryPrice)
      } else {
        expect(t.stopLoss).toBeGreaterThan(t.entryPrice)
        if (t.takeProfit !== null) expect(t.takeProfit).toBeLessThan(t.entryPrice)
      }
      // The stop is 1.5 ATR, so R distance must be strictly positive.
      expect(t.rDistance).toBeGreaterThan(0)
    }
  })

  it('places its target AT the Bollinger middle of the signal bar', () => {
    // The load-bearing claim of the whole strategy: the target is the mean,
    // not an arbitrary distance. Verify against an independent computation.
    const r = runBacktest(dataset, cfgFor(spec))
    const bb = bollinger(dataset.candles, 20, 2)
    const withTarget = r.trades.filter((t) => t.takeProfit !== null)
    expect(withTarget.length).toBeGreaterThan(0)

    for (const t of withTarget.slice(0, 40)) {
      // Signal bar is the bar BEFORE the fill (MARKET orders fill next bar).
      const signalBar = t.entryBar - 1
      const middle = bb.middle[signalBar]
      expect(middle).not.toBeNull()
      // The claim is about the LEVEL, not the distance: the target sits AT the
      // Bollinger middle of the signal bar. The distance from the fill differs
      // by whatever the market gapped overnight, which is a property of the
      // market, not of the strategy.
      expect(t.takeProfit as number).toBeCloseTo(middle as number, 6)
    }
  })

  it('only enters when price is genuinely outside the band', () => {
    const r = runBacktest(dataset, cfgFor(spec))
    const bb = bollinger(dataset.candles, 20, 2)
    for (const t of r.trades.slice(0, 40)) {
      const signalBar = t.entryBar - 1
      const close = dataset.candles[signalBar].c
      if (t.side === 'LONG') expect(close).toBeLessThan(bb.lower[signalBar] as number)
      else expect(close).toBeGreaterThan(bb.upper[signalBar] as number)
    }
  })
})

describe('gold mean reversion (BB+CCI+MFI)', () => {
  it('adds exactly one MFI condition per side, at 20 / 80', () => {
    const spec = PRESET_GOLD_MEANREV_BB_CCI_MFI
    expect(spec.entry.rules).toHaveLength(3)
    expect(spec.entry.rules[2]).toMatchObject({
      cmp: 'LT',
      left: { type: 'mfi', period: 14 },
      right: { type: 'value', value: 20 },
    })
    expect(spec.entryShort!.rules[2]).toMatchObject({
      cmp: 'GT',
      left: { type: 'mfi', period: 14 },
      right: { type: 'value', value: 80 },
    })
  })

  it('keeps the same exits as the two-condition version', () => {
    expect(PRESET_GOLD_MEANREV_BB_CCI_MFI.exit).toEqual(PRESET_GOLD_MEANREV_BB_CCI.exit)
  })

  it('cannot trade MORE than the version without the MFI filter', () => {
    // An extra AND condition is a strict subset of the signals. If this ever
    // inverts, the filter is not doing what its name says.
    const without = runBacktest(dataset, cfgFor(PRESET_GOLD_MEANREV_BB_CCI))
    const with_ = runBacktest(dataset, cfgFor(PRESET_GOLD_MEANREV_BB_CCI_MFI))
    expect(with_.trades.length).toBeLessThanOrEqual(without.trades.length)
  })
})

describe('gold momentum (breakout)', () => {
  const spec = PRESET_GOLD_MOMENTUM

  it('is a breakout with an R-multiple target, not a mean-reversion fade', () => {
    expect(spec.entryMode.mode).toBe('BREAKOUT_OCO')
    expect(spec.exit.target).toMatchObject({ unit: 'R', value: 2.5 })
  })

  it('restricts to London and New York and requires live volatility', () => {
    const session = spec.filters.find((f) => 'kind' in f && f.kind === 'session') as
      | { sessions: string[] }
      | undefined
    expect(session?.sessions).toEqual(['LONDON', 'NY'])
    expect(spec.filters.some((f) => 'kind' in f && f.kind === 'htfAlignment')).toBe(true)
  })

  it('runs and books trades with breakout geometry', () => {
    const r = runBacktest(dataset, cfgFor(spec))
    // Filters are strict, so a modest count is expected — but not zero.
    expect(r.trades.length).toBeGreaterThan(0)

    const ratios: number[] = []
    for (const t of r.trades) {
      expect(t.rDistance).toBeGreaterThan(0)
      // Levels must always bracket the entry on the correct sides.
      if (t.side === 'LONG') {
        expect(t.stopLoss).toBeLessThan(t.entryPrice)
        if (t.takeProfit !== null) expect(t.takeProfit).toBeGreaterThan(t.entryPrice)
      } else {
        expect(t.stopLoss).toBeGreaterThan(t.entryPrice)
        if (t.takeProfit !== null) expect(t.takeProfit).toBeLessThan(t.entryPrice)
      }
      if (t.takeProfit !== null) {
        ratios.push(Math.abs(t.takeProfit - t.entryPrice) / Math.abs(t.entryPrice - t.stopLoss))
      }
    }

    // Levels are priced off the TRIGGER, so a gap between trigger and fill
    // shifts the realised reward-to-risk either way. The spec's 2.5R must
    // still be what the typical trade gets — assert the median, not every
    // single trade, because demanding the latter would be asserting that
    // gaps do not exist.
    ratios.sort((a, b) => a - b)
    const median = ratios[Math.floor(ratios.length / 2)]
    expect(median).toBeGreaterThan(2.0)
    expect(median).toBeLessThan(3.0)
  })

  it('is the opposite bet to mean reversion on the same data', () => {
    // Not an assertion about which wins — only that they are genuinely
    // different strategies rather than the same one relabelled.
    const mr = runBacktest(dataset, cfgFor(PRESET_GOLD_MEANREV_BB_CCI))
    const mo = runBacktest(dataset, cfgFor(PRESET_GOLD_MOMENTUM))
    const mrBars = new Set(mr.trades.map((t) => t.entryBar))
    const overlap = mo.trades.filter((t) => mrBars.has(t.entryBar)).length
    expect(overlap).toBeLessThan(Math.max(2, mo.trades.length * 0.5))
  })
})

describe('indicator target safety', () => {
  it('accepts any band as a target while the geometry stays coherent', () => {
    // Worth stating explicitly: because this strategy only enters when price
    // is OUTSIDE the band, all three band lines sit on the profitable side of
    // the entry — a long entered below the lower band has the lower, middle
    // and upper bands all above it. So targeting the lower band is unusual
    // but perfectly coherent, and the engine should take it.
    const lowerBandTarget: StrategySpec = {
      ...PRESET_GOLD_MEANREV_BB_CCI,
      id: 'lower_band_target',
      exit: {
        ...PRESET_GOLD_MEANREV_BB_CCI.exit,
        target: {
          unit: 'INDICATOR',
          operand: { type: 'bollinger', period: 20, stdDevs: 2, band: 'lower' },
        },
      },
    }
    const r = runBacktest(dataset, cfgFor(lowerBandTarget))
    expect(r.trades.length).toBeGreaterThan(0)
    for (const t of r.trades) {
      if (t.takeProfit === null) continue
      if (t.side === 'LONG') expect(t.takeProfit).toBeGreaterThan(t.entryPrice)
      else expect(t.takeProfit).toBeLessThan(t.entryPrice)
    }
  })

  it('refuses a long whose indicator target sits below the entry', () => {
    // A genuinely inverted case: go long, but aim at the 20-bar rolling LOW,
    // which is by construction at or below the current price. There is no
    // coherent trade there, and the engine must decline rather than quietly
    // flip the level to the other side of the entry.
    const inverted: StrategySpec = {
      ...PRESET_GOLD_MEANREV_BB_CCI,
      id: 'inverted_target',
      direction: 'long',
      entry: {
        kind: 'group',
        op: 'AND',
        rules: [
          {
            kind: 'condition',
            left: { type: 'price', field: 'close' },
            cmp: 'GT',
            right: { type: 'value', value: 0 },
          },
        ],
      },
      entryShort: null,
      exit: {
        ...PRESET_GOLD_MEANREV_BB_CCI.exit,
        target: { unit: 'INDICATOR', operand: { type: 'rollingLow', period: 20 } },
      },
    }
    const r = runBacktest(dataset, cfgFor(inverted))
    expect(r.rejections.BAD_TARGET ?? 0).toBeGreaterThan(0)
    // Nothing may slip through with inverted geometry.
    for (const t of r.trades) {
      if (t.takeProfit !== null) expect(t.takeProfit).toBeGreaterThan(t.entryPrice)
    }
  })
})
