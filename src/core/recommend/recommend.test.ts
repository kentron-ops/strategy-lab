import { describe, expect, it } from 'vitest'
import {
  buildExpectancyBook,
  lookupCell,
  measureDecay,
  DEFAULT_BOOK_SPEC,
} from './expectancyBook'
import { compareRecommendations, rankRecommendations, scanSetups } from './scanner'
import { ShadowEngine } from '../replay/shadowEngine'
import { ReplayAdapter } from '../marketdata/replayAdapter'
import { CsvAdapter } from '../marketdata/csvAdapter'
import { runBacktest } from '../backtest/engine'
import { computeIndicators } from '../indicators'
import { makeBacktestConfig, makeDataset, zigzag } from '../testing/fixtures'
import { makeConfig } from '../strategy/registry'
import type { Recommendation } from './scanner'
import type { Trade } from '../types'

function makeTrade(over: Partial<Trade>): Trade {
  return {
    id: 't', strategyId: 's', side: 'LONG', qty: 1, tag: 'breakout_long',
    entryBar: 0, entryTime: 0, entryPrice: 100,
    exitBar: 5, exitTime: 5 * 300000, exitPrice: 101,
    stopLoss: 99, takeProfit: 102, rDistance: 1, riskAmount: 100,
    exitReason: 'TARGET', grossPnl: 100, costs: 0, netPnl: 100, r: 1,
    mfeR: 1.5, maeR: 0.4, barsHeld: 5, holdingMs: 5 * 300000,
    ambiguous: false, excluded: false,
    session: 'LONDON', regime: { vol: 'MID_VOL', trend: 'TRENDING' },
    equityAfter: 0, reasons: [],
    ...over,
  }
}

describe('expectancy book', () => {
  const trades: Trade[] = [
    // 40 London winners, 20 London losers → 0.33R London edge
    ...Array.from({ length: 40 }, (_, i) => makeTrade({ id: `lw${i}`, entryTime: i * 1000 })),
    ...Array.from({ length: 20 }, (_, i) =>
      makeTrade({ id: `ll${i}`, netPnl: -100, r: -1, exitReason: 'STOP', entryTime: (i + 40) * 1000 }),
    ),
    // 30 Asia trades, net negative
    ...Array.from({ length: 10 }, (_, i) =>
      makeTrade({ id: `aw${i}`, session: 'ASIA', entryTime: (i + 60) * 1000 }),
    ),
    ...Array.from({ length: 20 }, (_, i) =>
      makeTrade({ id: `al${i}`, session: 'ASIA', netPnl: -100, r: -1, exitReason: 'STOP', entryTime: (i + 70) * 1000 }),
    ),
  ]

  it('conditions expectancy on session, and the conditioning matters', () => {
    const book = buildExpectancyBook(trades, DEFAULT_BOOK_SPEC)
    const london = book.cells.find((c) => c.session === 'LONDON')
    const asia = book.cells.find((c) => c.session === 'ASIA')
    expect(london).toBeDefined()
    expect(asia).toBeDefined()
    expect(london!.expectancyR.point).toBeGreaterThan(0)
    expect(asia!.expectancyR.point).toBeLessThan(0)
    // The unconditional baseline hides both facts.
    expect(book.baseline!.expectancyR.point).toBeLessThan(london!.expectancyR.point)
    expect(book.baseline!.expectancyR.point).toBeGreaterThan(asia!.expectancyR.point)
  })

  it('every cell carries its sample size', () => {
    const book = buildExpectancyBook(trades)
    for (const cell of book.cells) {
      expect(cell.n).toBeGreaterThan(0)
      expect(cell.expectancyR.n).toBe(cell.n)
      expect(cell.hitRate.n).toBe(cell.n)
    }
  })

  it('marks thin cells inadequate instead of hiding or ranking them', () => {
    const thin = [
      ...Array.from({ length: 3 }, (_, i) => makeTrade({ id: `t${i}`, session: 'NY' })),
    ]
    const book = buildExpectancyBook([...trades, ...thin])
    const ny = book.cells.find((c) => c.session === 'NY')
    expect(ny).toBeDefined()
    expect(ny!.adequate).toBe(false)
  })

  it('warns when conditioning has shredded the sample', () => {
    const book = buildExpectancyBook(trades.slice(0, 8))
    expect(book.warnings.join(' ')).toMatch(/Conditioning has cut the data|cells from/)
  })

  it('lookup falls back gracefully and says how specific the answer is', () => {
    const book = buildExpectancyBook(trades)
    const exact = lookupCell(book, 'breakout_long', 'LONDON', { vol: 'MID_VOL', trend: 'TRENDING' }, 'LONG')
    expect(exact.cell).not.toBeNull()

    const missing = lookupCell(book, 'nonexistent_setup', 'LONDON', { vol: 'MID_VOL', trend: 'TRENDING' }, 'LONG')
    expect(missing.specificity).toBe('BASELINE')
  })
})

describe('edge decay', () => {
  it('reports HOLDING when recent matches baseline', () => {
    const trades = Array.from({ length: 100 }, (_, i) =>
      makeTrade({ id: String(i), entryTime: i * 1000, netPnl: i % 3 === 0 ? -100 : 80, r: i % 3 === 0 ? -1 : 0.8 }),
    )
    const d = measureDecay(trades)
    expect(d.status).toBe('HOLDING')
  })

  it('reports DYING when the recent window turns negative', () => {
    const good = Array.from({ length: 80 }, (_, i) =>
      makeTrade({ id: `g${i}`, entryTime: i * 1000, netPnl: 80, r: 0.8 }),
    )
    const bad = Array.from({ length: 25 }, (_, i) =>
      makeTrade({ id: `b${i}`, entryTime: (i + 80) * 1000, netPnl: -100, r: -1, exitReason: 'STOP' }),
    )
    const d = measureDecay([...good, ...bad])
    expect(d.status).toBe('DYING')
    expect(d.message).toMatch(/stopped working/)
  })

  it('treats a suddenly spectacular recent period as a WARNING, not a trophy', () => {
    const modest = Array.from({ length: 80 }, (_, i) =>
      makeTrade({ id: `m${i}`, entryTime: i * 1000, netPnl: i % 2 ? 30 : -20, r: i % 2 ? 0.3 : -0.2 }),
    )
    const spectacular = Array.from({ length: 25 }, (_, i) =>
      makeTrade({ id: `s${i}`, entryTime: (i + 80) * 1000, netPnl: 300, r: 3 }),
    )
    const d = measureDecay([...modest, ...spectacular])
    expect(d.status).toBe('SUSPICIOUSLY_GOOD')
    expect(d.message).toMatch(/warning, not a trophy/)
  })

  it('refuses to assess decay on a thin history', () => {
    const d = measureDecay(Array.from({ length: 10 }, (_, i) => makeTrade({ id: String(i) })))
    expect(d.status).toBe('UNKNOWN')
  })
})

describe('scanner', () => {
  const dataset = makeDataset(zigzag(600, { amplitude: 3, period: 24, drift: 0.01 }))
  const config = makeBacktestConfig('oco_breakout')

  function scan(): Recommendation[] {
    const backtest = runBacktest(dataset, config)
    const book = buildExpectancyBook(backtest.trades, { ...DEFAULT_BOOK_SPEC, minSample: 5 })
    const ind = computeIndicators(dataset.candles, config.indicators, dataset.timeframe)
    return scanSetups([makeConfig('oco_breakout')], {
      candles: dataset.candles,
      i: dataset.candles.length - 1,
      ind,
      equity: 10000,
      instrument: config.instrument,
      config,
      book,
      decay: measureDecay(backtest.trades),
      minutesToNextEvent: null,
    })
  }

  it('emits recommendations with evidence, sizing, and a named biggest risk', () => {
    const recs = scan()
    expect(recs.length).toBeGreaterThan(0)
    for (const r of recs) {
      expect(r.entry).toBeGreaterThan(0)
      expect(r.stopLoss).toBeGreaterThan(0)
      expect(r.biggestRisk.length).toBeGreaterThan(10)
      expect(r.explanation.length).toBeGreaterThan(30)
      expect(r.scenarios).toHaveLength(3)
      const pSum = r.scenarios.reduce((a, s) => a + s.probability, 0)
      expect(pSum).toBeCloseTo(1, 6)
      expect(r.sizingReason.length).toBeGreaterThan(10)
    }
  })

  it('never says "certain" anywhere in its output', () => {
    const recs = scan()
    for (const r of recs) {
      const text = JSON.stringify(r).toLowerCase()
      expect(text.includes('"certain"')).toBe(false)
      expect(r.explanation.toLowerCase()).not.toMatch(/\bcertain(ty|ly)?\b/)
    }
  })

  it('sorts insufficient-evidence setups to the bottom regardless of raw numbers', () => {
    const good: Recommendation = {
      ...scan()[0],
      id: 'good', grade: 'B', riskAdjustedEV: 0.2, expectedValueR: 0.2, action: 'LONG',
    }
    const luckyButThin: Recommendation = {
      ...good,
      id: 'thin', grade: 'INSUFFICIENT', riskAdjustedEV: -Infinity, expectedValueR: 5, action: 'LONG',
    }
    const ranked = rankRecommendations([luckyButThin, good])
    expect(ranked[0].id).toBe('good')
    expect(ranked[1].id).toBe('thin')
  })

  it('compares two candidates on the confidence floor, not the point estimate', () => {
    const base = scan()[0]
    const flashy: Recommendation = {
      ...base, id: 'flashy', setup: 'flashy',
      evidence: { ...base.evidence, expectancyR: 1.2, expectancyLow: -0.4, expectancyHigh: 2.8, sampleSize: 40 },
      grade: 'C',
    }
    const steady: Recommendation = {
      ...base, id: 'steady', setup: 'steady',
      evidence: { ...base.evidence, expectancyR: 0.3, expectancyLow: 0.15, expectancyHigh: 0.45, sampleSize: 300 },
      grade: 'A',
    }
    const cmp = compareRecommendations(flashy, steady)
    expect(cmp.winner?.id).toBe('steady')
    expect(cmp.verdict).toMatch(/lower bound/)
  })
})

describe('adapters', () => {
  const dataset = makeDataset(zigzag(100))

  it('CsvAdapter serves history and refuses to pretend it can stream', async () => {
    const a = new CsvAdapter([dataset])
    expect(a.capabilities().live).toBe(false)
    const history = await a.getHistory({ symbol: 'TEST', timeframe: '5m' })
    expect(history).toHaveLength(100)
    expect(() => a.subscribe('TEST', '5m', () => {})).toThrow(/cannot stream/)
  })

  it('ReplayAdapter never reveals the future through getHistory', async () => {
    const a = new ReplayAdapter(dataset.candles, 'TEST', '5m')
    const controls = a.controls()

    expect(await a.getHistory({ symbol: 'TEST', timeframe: '5m' })).toHaveLength(0)

    const received: number[] = []
    a.subscribe('TEST', '5m', (c) => received.push(c.t))
    controls.step()
    controls.step()
    controls.step()

    expect(received).toHaveLength(3)
    const history = await a.getHistory({ symbol: 'TEST', timeframe: '5m' })
    expect(history).toHaveLength(3)
    expect(history[2].t).toBe(received[2])
    a.dispose()
  })

  it('shadow engine emits signals from replayed candles without any order code', () => {
    const config = makeBacktestConfig('oco_breakout')
    const backtest = runBacktest(dataset, config)
    const engine = new ShadowEngine({
      config,
      configs: [makeConfig('oco_breakout')],
      book: buildExpectancyBook(backtest.trades, { ...DEFAULT_BOOK_SPEC, minSample: 3 }),
      decay: null,
      timeframe: '5m',
      warmupBars: 60,
    })

    const signals: number[] = []
    engine.onSignal((s) => signals.push(s.barIndex))

    const replaySource = makeDataset(zigzag(300, { amplitude: 4, period: 30 }))
    engine.seed(replaySource.candles.slice(0, 80))
    for (const c of replaySource.candles.slice(80)) engine.push(c, true)

    expect(signals.length).toBeGreaterThan(0)
    // Forming (non-final) bars must not advance the engine.
    const before = engine.history().length
    engine.push({ t: Date.now(), o: 1, h: 2, l: 0.5, c: 1.5 }, false)
    expect(engine.history().length).toBe(before)
  })
})
