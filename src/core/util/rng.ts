/**
 * Deterministic RNG. Every stochastic result (Monte Carlo, synthetic data) is
 * seeded and the seed is stored with the result, so any number in this app can
 * be reproduced exactly.
 */

/** mulberry32 — small, fast, good enough for resampling and synthetic series. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box–Muller standard normal from a uniform generator. */
export function makeNormal(rng: () => number): () => number {
  let spare: number | null = null
  return function normal(): number {
    if (spare !== null) {
      const s = spare
      spare = null
      return s
    }
    let u = 0
    let v = 0
    let s = 0
    do {
      u = rng() * 2 - 1
      v = rng() * 2 - 1
      s = u * u + v * v
    } while (s === 0 || s >= 1)
    const mul = Math.sqrt((-2 * Math.log(s)) / s)
    spare = v * mul
    return u * mul
  }
}

/** Fisher–Yates, non-mutating. */
export function shuffle<T>(xs: T[], rng: () => number): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/** Sample `n` items with replacement (bootstrap). */
export function sampleWithReplacement<T>(xs: T[], n: number, rng: () => number): T[] {
  const out: T[] = []
  if (!xs.length) return out
  for (let i = 0; i < n; i++) out.push(xs[Math.floor(rng() * xs.length)])
  return out
}
