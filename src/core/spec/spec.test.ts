import { describe, expect, it } from 'vitest'
import type { StrategySpec } from './types'
import { validateSpec, specIsRunnable } from './validate'
import { compileSpec } from './compile'
import { makeSpecConfig, resolveStrategyConfig } from './resolve'
import { PRESET_CONTINUATION, PRESET_HEDGE, PRESET_OCO, PRESET_SPECS } from './presets'
import { runBacktest } from '../backtest/engine'
import { makeBacktestConfig, makeDataset, zigzag } from '../testing/fixtures'
import type { Candle } from '../types'

const dataset = makeDataset(zigzag(900, { amplitude: 3, period: 24, drift: 0.006 }))

function specBacktestConfig(spec: StrategySpec) {
  const base = makeBacktestConfig('oco_breakout')
  return { ...base, strategy: makeSpecConfig(spec) }
}

describe('spec validation', () => {
  it('accepts every built-in preset', () => {
    for (const p of PRESET_SPECS) {
      const issues = validateSpec(p)
      expect(specIsRunnable(issues), `${p.id}: ${JSON.stringify(issues)}`).toBe(true)
    }
  })

  it('rejects a spec without a positive stop', () => {
    const bad: StrategySpec = {
      ...PRESET_OCO,
      exit: { ...PRESET_OCO.exit, stop: { unit: 'ATR', value: 0 } },
    }
    const issues = validateSpec(bad)
    expect(specIsRunnable(issues)).toBe(false)
    expect(issues.some((i) => i.path.startsWith('exit.stop'))).toBe(true)
  })

  it('rejects MARKET mode with no entry rules — it would enter every bar', () => {
    const bad: StrategySpec = {
      ...PRESET_OCO,
      direction: 'long',
      entryMode: { mode: 'MARKET' },
    }
    const issues = validateSpec(bad)
    expect(specIsRunnable(issues)).toBe(false)
  })

  it('rejects MARKET + both directions without explicit short rules', () => {
    const bad: StrategySpec = {
      ...PRESET_OCO,
      entryMode: { mode: 'MARKET' },
      entry: {
        kind: 'group',
        op: 'AND',
        rules: [
          {
            kind: 'condition',
            left: { type: 'ema', period: 10 },
            cmp: 'CROSS_ABOVE',
            right: { type: 'ema', period: 30 },
          },
        ],
      },
    }
    const issues = validateSpec(bad)
    expect(issues.some((i) => i.path === 'entryShort')).toBe(true)
  })

  it('rejects two constants crossing and empty session filters', () => {
    const bad: StrategySpec = {
      ...PRESET_OCO,
      entry: {
        kind: 'group',
        op: 'AND',
        rules: [
          {
            kind: 'condition',
            left: { type: 'value', value: 1 },
            cmp: 'CROSS_ABOVE',
            right: { type: 'value', value: 2 },
          },
        ],
      },
      filters: [{ kind: 'session', sessions: [] }],
    }
    const issues = validateSpec(bad)
    expect(issues.filter((i) => i.severity === 'ERROR').length).toBeGreaterThanOrEqual(2)
  })
})

describe('spec round trip', () => {
  it('survives JSON serialization unchanged', () => {
    for (const p of PRESET_SPECS) {
      expect(JSON.parse(JSON.stringify(p))).toEqual(p)
    }
  })

  it('resolves a spec config into a runnable strategy with the spec values as defaults', () => {
    const cfg = resolveStrategyConfig(makeSpecConfig(PRESET_OCO))
    expect(cfg.params.spec_lookback).toBe(20)
    expect(cfg.params.spec_stopValue).toBe(1.5)
    expect(cfg.params.spec_targetValue).toBe(2)
  })

  it('refuses to resolve an invalid spec', () => {
    const bad: StrategySpec = {
      ...PRESET_OCO,
      exit: { ...PRESET_OCO.exit, stop: { unit: 'ATR', value: -1 } },
    }
    expect(() => resolveStrategyConfig(makeSpecConfig(bad))).toThrow(/not runnable/)
  })
})

describe('compiled presets behave like their reference strategies', () => {
  it('preset OCO breakout produces the same trades as the built-in oco_breakout', () => {
    // Same geometry, same engine — the compiled spec must reproduce the
    // reference implementation trade for trade. This is the compiler's own
    // differential test.
    const reference = runBacktest(
      dataset,
      makeBacktestConfig('oco_breakout', {}, {
        lookback: 20,
        bufferAtrMultiple: 0.1,
        stopAtrMultiple: 1.5,
        targetR: 2,
        timeoutBars: 96,
        orderExpiryBars: 12,
        sessionFilter: 'ALL',
        cooldownBars: 0,
      }),
    )
    const compiled = runBacktest(dataset, specBacktestConfig(PRESET_OCO))

    expect(compiled.trades.length).toBe(reference.trades.length)
    expect(compiled.trades.map((t) => [t.entryBar, t.exitBar, t.side, t.exitReason])).toEqual(
      reference.trades.map((t) => [t.entryBar, t.exitBar, t.side, t.exitReason]),
    )
    expect(compiled.metrics.netPnl).toBeCloseTo(reference.metrics.netPnl, 6)
  })

  it('preset hedge opens both legs together', () => {
    const cfg = specBacktestConfig(PRESET_HEDGE)
    cfg.risk = { ...cfg.risk, maxConcurrentPositions: 2 }
    const r = runBacktest(dataset, cfg)
    expect(r.trades.length).toBeGreaterThan(1)
    const longs = r.trades.filter((t) => t.side === 'LONG').length
    const shorts = r.trades.filter((t) => t.side === 'SHORT').length
    expect(Math.abs(longs - shorts)).toBeLessThanOrEqual(1)
  })

  it('preset continuation trades less than plain OCO — the filters must cost sample', () => {
    const oco = runBacktest(dataset, specBacktestConfig(PRESET_OCO))
    const cont = runBacktest(dataset, specBacktestConfig(PRESET_CONTINUATION))
    expect(cont.trades.length).toBeLessThanOrEqual(oco.trades.length)
    // And the rejections say why, by name.
    const codes = Object.keys(cont.rejections)
    expect(codes.some((c) => ['SESSION_BLOCKED', 'FILTER_BLOCKED', 'HTF_FLAT', 'HTF_WARMUP', 'FILTER_WARMUP', 'NO_SIGNAL'].includes(c))).toBe(true)
  })
})

describe('compiled rule semantics', () => {
  it('EMA cross entry only fires on the crossing bar', () => {
    // A series that trends down then up gives one clean golden cross.
    const candles: Candle[] = []
    const start = Date.UTC(2025, 0, 6)
    for (let i = 0; i < 300; i++) {
      const base = i < 150 ? 200 - i * 0.5 : 125 + (i - 150) * 0.8
      candles.push({ t: start + i * 300000, o: base, h: base + 0.6, l: base - 0.6, c: base + 0.1, v: 100 })
    }
    const spec: StrategySpec = {
      ...PRESET_OCO,
      id: 'test_cross',
      name: 'cross test',
      direction: 'long',
      entryMode: { mode: 'MARKET' },
      entry: {
        kind: 'group',
        op: 'AND',
        rules: [
          {
            kind: 'condition',
            left: { type: 'ema', period: 10 },
            cmp: 'CROSS_ABOVE',
            right: { type: 'ema', period: 40 },
          },
        ],
      },
      exit: { stop: { unit: 'ATR', value: 2, atrPeriod: 14 }, target: null, timeoutBars: 50 },
      filters: [],
    }
    const r = runBacktest(makeDataset(candles), specBacktestConfig(spec))
    // One regime change → at most a couple of crosses, never dozens.
    expect(r.trades.length).toBeGreaterThan(0)
    expect(r.trades.length).toBeLessThanOrEqual(3)
    for (const t of r.trades) expect(t.side).toBe('LONG')
  })

  it('warm-up refuses to trade rather than guessing', () => {
    const spec: StrategySpec = {
      ...PRESET_OCO,
      id: 'test_warmup',
      direction: 'long',
      entryMode: { mode: 'MARKET' },
      entry: {
        kind: 'group',
        op: 'AND',
        rules: [
          {
            kind: 'condition',
            left: { type: 'sma', period: 800 }, // never warms up on 900 bars minus range
            cmp: 'GT',
            right: { type: 'value', value: 0 },
          },
        ],
      },
      filters: [],
    }
    const r = runBacktest(dataset, {
      ...specBacktestConfig(spec),
      toIndex: 500,
    })
    expect(r.trades.length).toBe(0)
    expect(r.rejections.RULE_WARMUP ?? 0).toBeGreaterThan(0)
  })
})
