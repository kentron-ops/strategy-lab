import { describe, expect, it } from 'vitest'
import { importJournalCsv, journalToCsv, makeEntry } from './import'
import { findBar, reconcileEntry, measureExcursions } from './reconcile'
import { tagBehaviors, costOfBehaviors, DEFAULT_BEHAVIOR } from './behaviorTags'
import {
  analyseJournal,
  compareToMechanical,
  enrichEntries,
  suggestImprovements,
  DEFAULT_ENRICH,
} from './analytics'
import { makeDataset } from '../testing/fixtures'
import { computeMetrics } from '../backtest/metrics'
import { TF_MS, DEFAULT_INSTRUMENT } from '../types'
import type { Candle } from '../types'

const BAR = TF_MS['5m']
const T0 = Date.UTC(2025, 0, 6, 8, 0, 0)

/** Flat, predictable market: every bar spans 99–101 around a 100 close. */
const marketCandles: Candle[] = Array.from({ length: 200 }, (_, i) => ({
  t: T0 + i * BAR,
  o: 100,
  h: 101,
  l: 99,
  c: 100,
}))
const market = makeDataset(marketCandles, '5m', 'XAUUSD')

describe('journal import', () => {
  const csv = [
    'symbol,side,qty,entry time,entry price,exit time,exit price,stop loss,fees,setup',
    'XAUUSD,long,1,2025-01-06T08:00:00Z,100,2025-01-06T08:30:00Z,101,99,0.5,breakout',
    'XAUUSD,sell,2,2025-01-06T09:00:00Z,100.5,2025-01-06T09:30:00Z,100,101.5,0.5,fade',
  ].join('\n')

  it('reads a broker-style file', () => {
    const r = importJournalCsv(csv)
    expect(r.entries).toHaveLength(2)
    expect(r.entries[0].side).toBe('LONG')
    expect(r.entries[1].side).toBe('SHORT')
    expect(r.entries[0].stopLoss).toBe(99)
    expect(r.entries[1].qty).toBe(2)
  })

  it('reports unreadable rows rather than defaulting them', () => {
    const r = importJournalCsv(csv + '\nXAUUSD,sideways,1,nonsense,100,x,101,99,0,x')
    expect(r.skipped).toHaveLength(1)
    expect(r.errors.join(' ')).toMatch(/skipped/)
  })

  it('refuses a file missing required columns', () => {
    const r = importJournalCsv('a,b\n1,2')
    expect(r.entries).toHaveLength(0)
    expect(r.errors[0]).toMatch(/Missing required column/)
  })

  it('round-trips through CSV export', () => {
    const r1 = importJournalCsv(csv)
    const r2 = importJournalCsv(journalToCsv(r1.entries))
    expect(r2.entries.map((e) => [e.side, e.entryPrice, e.exitPrice])).toEqual(
      r1.entries.map((e) => [e.side, e.entryPrice, e.exitPrice]),
    )
  })
})

describe('reconciliation — the reason to trust the numbers', () => {
  it('finds the bar covering a timestamp', () => {
    expect(findBar(marketCandles, T0, BAR)).toBe(0)
    expect(findBar(marketCandles, T0 + BAR * 5 + 60_000, BAR)).toBe(5)
    expect(findBar(marketCandles, T0 - 1, BAR)).toBe(-1)
  })

  it('verifies a plausible trade', () => {
    const e = makeEntry({
      symbol: 'XAUUSD', side: 'LONG', entryTime: T0, entryPrice: 100,
      exitTime: T0 + BAR * 4, exitPrice: 100.5, stopLoss: 99.5,
    })
    const r = reconcileEntry(e, market, BAR)
    expect(r.verdict).toBe('VERIFIED')
    expect(r.issues).toHaveLength(0)
  })

  it('catches an entry price the market never printed', () => {
    const e = makeEntry({
      symbol: 'XAUUSD', side: 'LONG', entryTime: T0, entryPrice: 140,
      exitTime: T0 + BAR * 4, exitPrice: 100.5, stopLoss: 139,
    })
    const r = reconcileEntry(e, market, BAR)
    expect(r.verdict).toBe('IMPLAUSIBLE')
    expect(r.issues.some((i) => i.code === 'ENTRY_PRICE_IMPOSSIBLE')).toBe(true)
    expect(r.issues[0].message).toMatch(/was not available at that moment/)
  })

  it('catches an exit price the market never printed', () => {
    const e = makeEntry({
      symbol: 'XAUUSD', side: 'LONG', entryTime: T0, entryPrice: 100,
      exitTime: T0 + BAR * 4, exitPrice: 3, stopLoss: 99,
    })
    const r = reconcileEntry(e, market, BAR)
    expect(r.issues.some((i) => i.code === 'EXIT_PRICE_IMPOSSIBLE')).toBe(true)
  })

  it('tolerates small differences, because the broker feed is not this feed', () => {
    const e = makeEntry({
      symbol: 'XAUUSD', side: 'LONG', entryTime: T0, entryPrice: 101.3,
      exitTime: T0 + BAR, exitPrice: 100, stopLoss: 99,
    })
    expect(reconcileEntry(e, market, BAR).verdict).toBe('VERIFIED')
  })

  it('notices a "stopped out" trade where price never reached the stop', () => {
    const e = makeEntry({
      symbol: 'XAUUSD', side: 'LONG', entryTime: T0, entryPrice: 100,
      exitTime: T0 + BAR * 3, exitPrice: 95, stopLoss: 95,
    })
    const r = reconcileEntry(e, market, BAR)
    // The price itself is impossible here, which is caught first and hardest.
    expect(r.verdict).toBe('IMPLAUSIBLE')
  })

  it('reports NO_DATA rather than passing a trade it cannot check', () => {
    const e = makeEntry({
      symbol: 'XAUUSD', entryTime: T0 - 10 * BAR, entryPrice: 100,
      exitTime: T0 - 5 * BAR, exitPrice: 101, stopLoss: 99,
    })
    expect(reconcileEntry(e, market, BAR).verdict).toBe('NO_DATA')
  })

  it('flags a symbol mismatch instead of silently comparing two markets', () => {
    const e = makeEntry({
      symbol: 'EURUSD', entryTime: T0, entryPrice: 100,
      exitTime: T0 + BAR, exitPrice: 100.5, stopLoss: 99,
    })
    const r = reconcileEntry(e, market, BAR)
    expect(r.issues.some((i) => i.code === 'SYMBOL_MISMATCH')).toBe(true)
  })

  it('measures how far the trade actually ran, in R', () => {
    const e = makeEntry({
      side: 'LONG', entryTime: T0, entryPrice: 100,
      exitTime: T0 + BAR * 10, exitPrice: 100.2, stopLoss: 99.5,
    })
    // 1R = 0.5; market high is 101 → +1 → 2R. Market low 99 → −1 → 2R.
    const x = measureExcursions(e, market, BAR)
    expect(x.mfeR).toBeCloseTo(2, 6)
    expect(x.maeR).toBeCloseTo(2, 6)
  })
})

describe('behavioural tags', () => {
  const base = (over: Record<string, unknown>) =>
    makeEntry({
      symbol: 'XAUUSD', side: 'LONG', qty: 1,
      entryTime: T0, entryPrice: 100, exitTime: T0 + BAR * 4, exitPrice: 101,
      stopLoss: 99, ...over,
    } as never)

  it('flags a trade with no stop', () => {
    const enriched = enrichEntries([base({ stopLoss: null })], DEFAULT_ENRICH)
    expect(enriched[0].tags).toContain('NO_STOP')
  })

  it('flags a re-entry moments after a loss', () => {
    const loser = base({
      entryTime: T0, entryPrice: 100, exitTime: T0 + BAR, exitPrice: 99, stopLoss: 99,
    })
    const revenge = base({
      entryTime: T0 + BAR + 60_000, entryPrice: 100, exitTime: T0 + BAR * 5, exitPrice: 101,
    })
    const enriched = enrichEntries([loser, revenge], DEFAULT_ENRICH)
    expect(enriched[1].tags).toContain('REVENGE_TRADE')
    expect(enriched[0].tags).not.toContain('REVENGE_TRADE')
  })

  it('flags an exit well beyond the logged stop as a moved stop', () => {
    const e = base({ exitPrice: 97, stopLoss: 99 })
    const enriched = enrichEntries([e], DEFAULT_ENRICH)
    expect(enriched[0].tags).toContain('MOVED_STOP')
  })

  it('flags trading outside planned hours', () => {
    const asia = base({ entryTime: Date.UTC(2025, 0, 6, 3, 0, 0) })
    const enriched = enrichEntries([asia], {
      ...DEFAULT_ENRICH,
      behavior: { ...DEFAULT_BEHAVIOR, plannedSessions: ['LONDON', 'NY'] },
    })
    expect(enriched[0].tags).toContain('OUTSIDE_PLAN_HOURS')
  })

  it('flags a winner cut far short of what it reached', () => {
    const e = base({ entryPrice: 100, stopLoss: 99.5, exitPrice: 100.1, exitTime: T0 + BAR * 10 })
    const enriched = enrichEntries([e], { ...DEFAULT_ENRICH, reference: market })
    // MFE was 2R (price hit 101); the trade banked 0.2R.
    expect(enriched[0].tags).toContain('CUT_WINNER_EARLY')
  })

  it('attributes a cost to each behaviour against the trader\'s own baseline', () => {
    const good = Array.from({ length: 10 }, (_, i) =>
      base({ entryTime: T0 + i * BAR * 20, exitTime: T0 + i * BAR * 20 + BAR, exitPrice: 101 }),
    )
    const bad = Array.from({ length: 5 }, (_, i) =>
      base({
        entryTime: T0 + (i + 20) * BAR * 20,
        exitTime: T0 + (i + 20) * BAR * 20 + BAR,
        exitPrice: 98,
        stopLoss: 99,
      }),
    )
    const enriched = enrichEntries([...good, ...bad], DEFAULT_ENRICH)
    const costs = costOfBehaviors(enriched)
    const moved = costs.find((c) => c.tag === 'MOVED_STOP')
    expect(moved).toBeDefined()
    expect(moved!.deltaR).toBeLessThan(0)
  })
})

describe('journal analytics', () => {
  const entries = [
    ...Array.from({ length: 12 }, (_, i) =>
      makeEntry({
        symbol: 'XAUUSD', side: 'LONG', qty: 1,
        entryTime: T0 + i * BAR * 8, entryPrice: 100,
        exitTime: T0 + i * BAR * 8 + BAR * 2, exitPrice: 100.5,
        stopLoss: 99.5, fees: 0, setupTag: 'breakout',
      }),
    ),
    ...Array.from({ length: 8 }, (_, i) =>
      makeEntry({
        symbol: 'XAUUSD', side: 'LONG', qty: 1,
        entryTime: T0 + (i + 20) * BAR * 8, entryPrice: 100,
        exitTime: T0 + (i + 20) * BAR * 8 + BAR * 2, exitPrice: 99.5,
        stopLoss: 99.5, fees: 0, setupTag: 'fade',
      }),
    ),
  ]

  it('computes metrics with the same code as the backtester', () => {
    const enriched = enrichEntries(entries, { ...DEFAULT_ENRICH, reference: market })
    const a = analyseJournal(enriched, 1000)
    expect(a.metrics.trades).toBe(20)
    expect(a.metrics.wins).toBe(12)
    expect(a.metrics.losses).toBe(8)
    expect(a.metrics.expectancyR.n).toBe(20)
  })

  it('slices by setup and by session', () => {
    const enriched = enrichEntries(entries, { ...DEFAULT_ENRICH, reference: market })
    const a = analyseJournal(enriched, 1000)
    expect(a.bySetup.map((s) => s.key).sort()).toEqual(['breakout', 'fade'])
    const breakout = a.bySetup.find((s) => s.key === 'breakout')!
    const fade = a.bySetup.find((s) => s.key === 'fade')!
    expect(breakout.expectancyR.point).toBeGreaterThan(fade.expectancyR.point)
  })

  it('warns when nothing has been verified against market data', () => {
    const enriched = enrichEntries(entries, DEFAULT_ENRICH)
    const a = analyseJournal(enriched, 1000)
    expect(a.warnings.join(' ')).toMatch(/nothing here has been verified/)
  })

  it('warns when trades have no stop, instead of quietly excluding them', () => {
    const noStop = [makeEntry({ entryTime: T0, entryPrice: 100, exitPrice: 101, stopLoss: null })]
    const a = analyseJournal(enrichEntries(noStop, DEFAULT_ENRICH), 1000)
    expect(a.warnings.join(' ')).toMatch(/no stop recorded/)
  })

  it('counts reconciliation verdicts', () => {
    const withBad = [
      ...entries.slice(0, 3),
      makeEntry({
        symbol: 'XAUUSD', entryTime: T0, entryPrice: 500,
        exitTime: T0 + BAR, exitPrice: 501, stopLoss: 499,
      }),
    ]
    const a = analyseJournal(
      enrichEntries(withBad, { ...DEFAULT_ENRICH, reference: market }),
      1000,
    )
    expect(a.reconciliation.implausible).toBe(1)
    expect(a.reconciliation.verified).toBe(3)
    expect(a.warnings.join(' ')).toMatch(/partly on fiction/)
  })
})

describe('the human-versus-mechanical gap', () => {
  const mk = (expectancyR: number, trades: number) => {
    const fake = Array.from({ length: trades }, () => ({
      netPnl: expectancyR * 100, r: expectancyR, riskAmount: 100,
    }))
    return computeMetrics(
      fake.map((f, i) => ({
        id: String(i), strategyId: 's', side: 'LONG' as const, qty: 1, tag: '',
        entryBar: i, entryTime: i * BAR, entryPrice: 100,
        exitBar: i, exitTime: i * BAR + BAR, exitPrice: 101,
        stopLoss: 99, takeProfit: null, rDistance: 1, riskAmount: 100,
        exitReason: 'TARGET' as const, grossPnl: f.netPnl, costs: 0, netPnl: f.netPnl,
        r: f.r, mfeR: 1, maeR: 0.5, barsHeld: 1, holdingMs: BAR,
        ambiguous: false, excluded: false, session: 'LONDON' as const,
        regime: { vol: 'MID_VOL' as const, trend: 'RANGING' as const },
        equityAfter: 0, reasons: [],
      })),
      [], 1000, { barsInPosition: 0, totalBars: 0 },
    )
  }

  it('says so plainly when the rules beat the person', () => {
    const gap = compareToMechanical(mk(0.05, 100), mk(0.45, 100))
    expect(gap.gapR).toBeCloseTo(0.4, 6)
    expect(gap.verdict).toMatch(/lost to execution rather than to the strategy/)
  })

  it('credits the person when they beat the rules', () => {
    const gap = compareToMechanical(mk(0.5, 100), mk(0.1, 100))
    expect(gap.gapR).toBeLessThan(0)
    expect(gap.verdict).toMatch(/You beat the mechanical version/)
  })

  it('refuses to conclude anything from a thin log', () => {
    const gap = compareToMechanical(mk(0.5, 8), mk(0.1, 100))
    expect(gap.verdict).toMatch(/directional at best/)
  })
})

describe('suggestions are tied to the trader\'s own numbers', () => {
  it('names the payoff problem when the win rate is fine but expectancy is not', () => {
    const entries = [
      ...Array.from({ length: 50 }, (_, i) =>
        makeEntry({
          side: 'LONG', entryTime: T0 + i * BAR * 8, entryPrice: 100,
          exitTime: T0 + i * BAR * 8 + BAR, exitPrice: 100.4, stopLoss: 99,
        }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        makeEntry({
          side: 'LONG', entryTime: T0 + (i + 60) * BAR * 8, entryPrice: 100,
          exitTime: T0 + (i + 60) * BAR * 8 + BAR, exitPrice: 99, stopLoss: 99,
        }),
      ),
    ]
    const enriched = enrichEntries(entries, DEFAULT_ENRICH)
    const a = analyseJournal(enriched, 1000)
    const s = suggestImprovements(a, enriched)
    expect(s.some((x) => /payoff/i.test(x.title))).toBe(true)
    for (const sug of s) {
      expect(sug.sampleSize).toBeGreaterThan(0)
      expect(sug.expectedEffect.length).toBeGreaterThan(10)
    }
  })

  it('leads with the sample-size warning when the log is thin', () => {
    const entries = [
      makeEntry({ entryTime: T0, entryPrice: 100, exitTime: T0 + BAR, exitPrice: 101, stopLoss: 99 }),
    ]
    const enriched = enrichEntries(entries, DEFAULT_ENRICH)
    const s = suggestImprovements(analyseJournal(enriched, 1000), enriched)
    expect(s[0].title).toMatch(/not yet enough here/)
    expect(s[0].confidence).toBe('LOW')
  })
})
