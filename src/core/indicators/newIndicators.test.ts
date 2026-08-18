import { describe, expect, it } from 'vitest'
import { bollinger, cci, mfi } from './index'
import type { Candle } from '../types'

/**
 * Golden fixtures for Bollinger / CCI / MFI.
 *
 * Every expected number below is derived by hand from the definition, on
 * inputs small enough to check on paper. Where a value is arithmetic-exact
 * (a flat series, a perfectly linear ramp) it is asserted exactly; where it
 * needs long division it is asserted against the worked-through figure.
 *
 * These sit alongside scripts/differential/compare_indicators.py, which runs
 * the same definitions in Python and demands agreement to 1e-9.
 */

/** Build bars whose close is `closes[i]`; high/low padded symmetrically. */
const closeBars = (closes: number[], pad = 0, volumes?: number[]): Candle[] =>
  closes.map((c, i) => ({
    t: i * 300000,
    o: c,
    h: c + pad,
    l: c - pad,
    c,
    v: volumes ? volumes[i] : 100,
  }))

/** Build bars from explicit high/low/close, for typical-price indicators. */
const hlcBars = (rows: [number, number, number][], volumes?: number[]): Candle[] =>
  rows.map(([h, l, c], i) => ({
    t: i * 300000,
    o: c,
    h,
    l,
    c,
    v: volumes ? volumes[i] : 100,
  }))

// ─────────────────────────────────────────────────────────────────────────────
// Bollinger Bands
// ─────────────────────────────────────────────────────────────────────────────

describe('golden: Bollinger Bands', () => {
  it('is null until the window is full, then defined on every bar', () => {
    const b = bollinger(closeBars([1, 2, 3, 4, 5]), 3, 2)
    expect(b.middle[0]).toBeNull()
    expect(b.middle[1]).toBeNull()
    expect(b.middle[2]).not.toBeNull()
    expect(b.middle[4]).not.toBeNull()
  })

  it('collapses to a single line on a flat series (σ = 0)', () => {
    // Every close 100 → mean 100, population σ 0 → all three bands equal.
    const b = bollinger(closeBars(new Array(10).fill(100)), 5, 2)
    expect(b.middle[9]).toBeCloseTo(100, 12)
    expect(b.upper[9]).toBeCloseTo(100, 12)
    expect(b.lower[9]).toBeCloseTo(100, 12)
    expect(b.bandwidth[9]).toBeCloseTo(0, 12)
  })

  it('matches the hand-computed population deviation on 1..5', () => {
    // Window = [1,2,3,4,5]: mean 3.
    // Population variance = ((−2)²+(−1)²+0²+1²+2²)/5 = 10/5 = 2 → σ = √2.
    const b = bollinger(closeBars([1, 2, 3, 4, 5]), 5, 2)
    const sd = Math.SQRT2
    expect(b.middle[4]).toBeCloseTo(3, 12)
    expect(b.upper[4]).toBeCloseTo(3 + 2 * sd, 12)
    expect(b.lower[4]).toBeCloseTo(3 - 2 * sd, 12)
    // Bandwidth = (upper − lower) / middle = 4σ/3.
    expect(b.bandwidth[4]).toBeCloseTo((4 * sd) / 3, 12)
  })

  it('uses the POPULATION deviation, not the sample one', () => {
    // Sample variance of 1..5 would be 10/4 = 2.5 → σ ≈ 1.5811, which would
    // put the upper band at 6.1623 instead of 5.8284. This asserts the
    // difference explicitly so the convention cannot drift unnoticed.
    const b = bollinger(closeBars([1, 2, 3, 4, 5]), 5, 2)
    expect(b.upper[4]).toBeCloseTo(5.82842712474619, 10)
    expect(b.upper[4]).not.toBeCloseTo(6.16227766016838, 6)
  })

  it('scales linearly with the stdDevs multiplier', () => {
    const one = bollinger(closeBars([1, 2, 3, 4, 5]), 5, 1)
    const three = bollinger(closeBars([1, 2, 3, 4, 5]), 5, 3)
    const mid = one.middle[4] as number
    expect((three.upper[4] as number) - mid).toBeCloseTo(3 * ((one.upper[4] as number) - mid), 12)
  })

  it('is causal: a later bar cannot change an earlier value', () => {
    const base = [10, 11, 12, 13, 14, 15, 16, 17]
    const a = bollinger(closeBars(base), 4, 2)
    const b = bollinger(closeBars([...base.slice(0, 6), 900, 950]), 4, 2)
    for (let i = 0; i <= 5; i++) {
      expect(b.middle[i]).toEqual(a.middle[i])
      expect(b.upper[i]).toEqual(a.upper[i])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CCI
// ─────────────────────────────────────────────────────────────────────────────

describe('golden: CCI', () => {
  it('is null while warming up', () => {
    const c = cci(closeBars([1, 2, 3, 4, 5]), 4)
    expect(c[0]).toBeNull()
    expect(c[2]).toBeNull()
    expect(c[3]).not.toBeNull()
  })

  it('is undefined (null) on a perfectly flat window rather than zero', () => {
    // Zero mean-absolute-deviation makes CCI a division by zero. Reporting 0
    // would claim "perfectly neutral" when the truth is "not defined".
    const c = cci(closeBars(new Array(8).fill(50)), 5)
    expect(c[7]).toBeNull()
  })

  it('matches the hand-computed value on a linear ramp', () => {
    // Typical price = close here (h = l = c). Window at i=4 is [1,2,3,4,5].
    // mean = 3; deviations |−2|,|−1|,0,1,2 → MAD = 6/5 = 1.2.
    // CCI = (5 − 3) / (0.015 × 1.2) = 2 / 0.018 = 111.111…
    const c = cci(closeBars([1, 2, 3, 4, 5]), 5)
    expect(c[4] as number).toBeCloseTo(2 / 0.018, 10)
    expect(c[4] as number).toBeCloseTo(111.1111111111, 8)
  })

  it('is symmetric: a mirrored series gives the negated reading', () => {
    const up = cci(closeBars([1, 2, 3, 4, 5]), 5)
    const down = cci(closeBars([5, 4, 3, 2, 1]), 5)
    expect(down[4] as number).toBeCloseTo(-(up[4] as number), 10)
  })

  it('uses the typical price (H+L+C)/3, not the close', () => {
    // Same closes, but highs/lows shifted upward on the final bar only.
    // Typical price on that bar becomes (12+8+5)/3 ≈ 8.33 instead of 5,
    // which must move the reading.
    const plain = cci(hlcBars([[1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4], [5, 5, 5]]), 5)
    const wick = cci(hlcBars([[1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4], [12, 8, 5]]), 5)
    expect(wick[4]).not.toBeCloseTo(plain[4] as number, 6)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MFI
// ─────────────────────────────────────────────────────────────────────────────

describe('golden: MFI', () => {
  it('is null while warming up', () => {
    const m = mfi(closeBars([1, 2, 3, 4, 5, 6]), 4)
    expect(m[0]).toBeNull()
    expect(m[3]).toBeNull()
    expect(m[4]).not.toBeNull()
  })

  it('reads 100 when every bar in the window rose', () => {
    // Monotonically rising typical price → no negative flow at all.
    const m = mfi(closeBars([1, 2, 3, 4, 5, 6, 7, 8]), 4)
    expect(m[7]).toBeCloseTo(100, 12)
  })

  it('reads 0 when every bar in the window fell', () => {
    const m = mfi(closeBars([8, 7, 6, 5, 4, 3, 2, 1]), 4)
    expect(m[7]).toBeCloseTo(0, 12)
  })

  it('matches the hand-computed value on an alternating series', () => {
    // Closes 10,20,10,20,10,20 with volume 1 → typical price = close.
    // Window of 4 ending at i=5 covers flows at i=2,3,4,5:
    //   i=2: 10 < 20 → negative 10×1 = 10
    //   i=3: 20 > 10 → positive 20×1 = 20
    //   i=4: 10 < 20 → negative 10
    //   i=5: 20 > 10 → positive 20
    // positive 40, negative 20 → ratio 2 → MFI = 100 − 100/3 = 66.666…
    const m = mfi(closeBars([10, 20, 10, 20, 10, 20], 0, [1, 1, 1, 1, 1, 1]), 4)
    expect(m[5] as number).toBeCloseTo(100 - 100 / 3, 10)
    expect(m[5] as number).toBeCloseTo(66.6666666667, 8)
  })

  it('weights by volume — a heavy down-bar drags the reading below the unweighted case', () => {
    const flat = mfi(closeBars([10, 20, 10, 20, 10, 20], 0, [1, 1, 1, 1, 1, 1]), 4)
    const heavyDown = mfi(closeBars([10, 20, 10, 20, 10, 20], 0, [1, 1, 50, 1, 50, 1]), 4)
    expect(heavyDown[5] as number).toBeLessThan(flat[5] as number)
  })

  it('treats an unchanged typical price as neither positive nor negative flow', () => {
    // Bars 3..6 are identical → no flow either way in that window, so the
    // ratio is undefined and the series must say null rather than guess.
    const m = mfi(closeBars([10, 11, 12, 12, 12, 12, 12]), 4)
    expect(m[6]).toBeNull()
  })

  it('handles missing volume as zero rather than crashing or inventing activity', () => {
    const noVol: Candle[] = [10, 11, 12, 13, 14, 15].map((c, i) => ({
      t: i * 300000, o: c, h: c, l: c, c,
    }))
    const m = mfi(noVol, 4)
    // All flows are zero → no positive and no negative → undefined, not 50.
    expect(m[5]).toBeNull()
  })

  it('is causal', () => {
    const base = [10, 11, 12, 11, 13, 12, 14, 15]
    const a = mfi(closeBars(base), 4)
    const b = mfi(closeBars([...base.slice(0, 6), 900, 950]), 4)
    for (let i = 0; i <= 5; i++) expect(b[i]).toEqual(a[i])
  })
})
