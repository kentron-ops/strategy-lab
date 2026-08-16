import { describe, expect, it } from 'vitest'
import {
  adx,
  atr,
  bodyRatioSeries,
  ema,
  rollingHigh,
  rollingLow,
  rollingPercentile,
  rsi,
  sma,
  trueRange,
} from './index'
import { sessionOf } from '../util/time'
import { DEFAULT_INDICATORS } from '../types'
import type { Candle } from '../types'
import { zigzag } from '../testing/fixtures'

const flat = (n: number, price = 100): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    t: i * 300000,
    o: price,
    h: price + 1,
    l: price - 1,
    c: price,
  }))

describe('warm-up is null, never back-filled', () => {
  const candles = zigzag(100)

  it('ATR is null until it has enough bars', () => {
    const a = atr(candles, 14)
    for (let i = 0; i < 14; i++) expect(a[i]).toBeNull()
    expect(a[14]).not.toBeNull()
  })

  it('EMA is null until the seed period completes', () => {
    const e = ema(candles.map((c) => c.c), 20)
    for (let i = 0; i < 19; i++) expect(e[i]).toBeNull()
    expect(e[19]).not.toBeNull()
  })

  it('rolling extremes are null until the window is full', () => {
    const hi = rollingHigh(candles, 10, true)
    for (let i = 0; i < 10; i++) expect(hi[i]).toBeNull()
    expect(hi[10]).not.toBeNull()
  })
})

describe('correctness on inputs with a known answer', () => {
  it('SMA of a constant is that constant', () => {
    const s = sma([5, 5, 5, 5, 5], 3)
    expect(s[2]).toBeCloseTo(5, 12)
    expect(s[4]).toBeCloseTo(5, 12)
  })

  it('EMA of a constant is that constant', () => {
    const e = ema(new Array(50).fill(7), 10)
    expect(e[49]).toBeCloseTo(7, 12)
  })

  it('ATR of a series with a constant 2-point range is 2', () => {
    const bars = flat(60)
    const a = atr(bars, 14)
    expect(a[59]).toBeCloseTo(2, 8)
  })

  it('true range accounts for gaps against the previous close', () => {
    const bars: Candle[] = [
      { t: 0, o: 100, h: 101, l: 99, c: 100 },
      { t: 1, o: 110, h: 111, l: 109, c: 110 }, // gapped up 10
    ]
    const tr = trueRange(bars)
    expect(tr[1]).toBeCloseTo(11, 10) // 111 − 100, not 111 − 109
  })

  it('RSI is 100 when every bar closes higher', () => {
    const rising: Candle[] = Array.from({ length: 40 }, (_, i) => ({
      t: i, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i,
    }))
    const r = rsi(rising, 14)
    expect(r[39]).toBeCloseTo(100, 6)
  })

  it('RSI sits near 50 on an alternating series', () => {
    const alt: Candle[] = Array.from({ length: 80 }, (_, i) => {
      const c = 100 + (i % 2)
      return { t: i, o: c, h: c + 0.5, l: c - 0.5, c }
    })
    const r = rsi(alt, 14)
    expect(r[79]).toBeGreaterThan(30)
    expect(r[79]).toBeLessThan(70)
  })

  it('ADX is higher on a trend than on chop', () => {
    const trend: Candle[] = Array.from({ length: 120 }, (_, i) => ({
      t: i, o: 100 + i, h: 101 + i, l: 99.5 + i, c: 100.8 + i,
    }))
    const chop: Candle[] = Array.from({ length: 120 }, (_, i) => {
      const base = 100 + (i % 2) * 0.5
      return { t: i, o: base, h: base + 1, l: base - 1, c: base }
    })
    const t = adx(trend, 14).filter((x): x is number => x !== null)
    const c = adx(chop, 14).filter((x): x is number => x !== null)
    expect(t[t.length - 1]).toBeGreaterThan(c[c.length - 1])
  })
})

describe('rolling extremes exclude the forming bar', () => {
  it('never includes the current bar in the range', () => {
    const bars: Candle[] = [
      { t: 0, o: 10, h: 10, l: 10, c: 10 },
      { t: 1, o: 20, h: 20, l: 20, c: 20 },
      { t: 2, o: 999, h: 999, l: 1, c: 500 }, // a huge bar
    ]
    const hi = rollingHigh(bars, 2, true)
    // At index 2 the window is bars 0..1 — the 999 must not appear.
    expect(hi[2]).toBe(20)

    const lo = rollingLow(bars, 2, true)
    expect(lo[2]).toBe(10)
  })

  it('includes it when explicitly asked to', () => {
    const bars: Candle[] = [
      { t: 0, o: 10, h: 10, l: 10, c: 10 },
      { t: 1, o: 20, h: 30, l: 20, c: 20 },
    ]
    expect(rollingHigh(bars, 2, false)[1]).toBe(30)
  })
})

describe('rolling percentile', () => {
  it('reports where the latest value sits in its own history', () => {
    const rising = Array.from({ length: 100 }, (_, i) => i as number | null)
    const p = rollingPercentile(rising, 50)
    // The newest value is the largest in its window.
    expect(p[99]).toBeCloseTo(49 / 50, 6)
  })

  it('is null until it has a usable history', () => {
    const short = [1, 2, 3] as (number | null)[]
    expect(rollingPercentile(short, 200)[2]).toBeNull()
  })
})

describe('body ratio', () => {
  it('is 1 for a full-bodied bar and 0 for a doji', () => {
    const bars: Candle[] = [
      { t: 0, o: 100, h: 105, l: 100, c: 105 },
      { t: 1, o: 100, h: 105, l: 95, c: 100 },
    ]
    const b = bodyRatioSeries(bars)
    expect(b[0]).toBeCloseTo(1, 10)
    expect(b[1]).toBeCloseTo(0, 10)
  })

  it('is null when the bar has no range at all', () => {
    expect(bodyRatioSeries([{ t: 0, o: 100, h: 100, l: 100, c: 100 }])[0]).toBeNull()
  })
})

describe('sessions', () => {
  const b = DEFAULT_INDICATORS.sessionBoundsUtc

  it('maps UTC hours to the right session', () => {
    expect(sessionOf(Date.UTC(2025, 0, 6, 3), b)).toBe('ASIA')
    expect(sessionOf(Date.UTC(2025, 0, 6, 9), b)).toBe('LONDON')
    expect(sessionOf(Date.UTC(2025, 0, 6, 15), b)).toBe('NY')
    expect(sessionOf(Date.UTC(2025, 0, 6, 23), b)).toBe('OFF')
  })

  it('treats bounds as half-open so no hour lands in two sessions', () => {
    expect(sessionOf(Date.UTC(2025, 0, 6, 7), b)).toBe('LONDON')
    expect(sessionOf(Date.UTC(2025, 0, 6, 6, 59), b)).toBe('ASIA')
    expect(sessionOf(Date.UTC(2025, 0, 6, 13), b)).toBe('NY')
  })

  it('handles a session that wraps past midnight', () => {
    const wrapped = { ...b, OFF: [22, 3] as [number, number] }
    expect(sessionOf(Date.UTC(2025, 0, 6, 23), wrapped)).toBe('OFF')
  })
})
