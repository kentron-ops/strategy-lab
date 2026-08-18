import type { Candle } from '../../types'

/**
 * Regression fixture captured from a fast-check run (numRuns=1000, unpinned).
 *
 * A nearly-flat price series (all 445.0703, then a 0.010% dip to 445.0659,
 * ending with a single 0.0001 uptick on the last bar). Combined with
 * `stopAtrMultiple: 1` and fixed-fractional sizing, the R-distance becomes
 * tiny, quantities compound with equity, and OPTIMISTIC (which wins each
 * ambiguous bar) can end MUCH farther below CONSERVATIVE because its bigger
 * quantities magnify later losers.
 *
 * This proved the test's original assertion wrong: "same entries + only
 * ambiguous bars differ ⇒ opti ≥ cons at equity level" implicitly assumed
 * constant quantities. The rewritten assertion compares per-unit gross,
 * which is the invariant that actually holds.
 *
 * This series is pinned as a fast-check example so this exact case is
 * always exercised, in addition to random exploration.
 */
export const OPTI_CONS_BLOWUP: Candle[] = buildFlatSeries()

function buildFlatSeries(): Candle[] {
  const out: Candle[] = []
  const start = 1736121600000
  // 22 bars at 445.0703, one 0.0001-wick, more flats, then dip to 445.0659
  // for the rest of the series with a single high poke at the end.
  const push = (o: number, h: number, l: number, c: number, i: number): void => {
    out.push({ t: start + i * 300000, o, h, l, c, v: 100 })
  }
  const A = 445.0703
  const B = 445.0659
  // bars 0..20 at A
  for (let i = 0; i < 21; i++) push(A, A, A, A, i)
  // bar 21: wick up to A+0.0001 with close at A
  push(A, 445.0704, A, A, 21)
  // bar 22..: dip open A, wick down to B, close A
  push(A, A, B, A, 22)
  // long flat run at B
  for (let i = 23; i < 170; i++) push(B, B, B, B, i)
  // final tail bar with tiny upper wick
  push(B, 445.066, B, B, 170)
  return out
}
