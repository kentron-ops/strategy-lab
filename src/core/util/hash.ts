/**
 * Content hashing for provenance. Not cryptographic — its only job is to make
 * "these results came from exactly these bytes" checkable.
 */

/** FNV-1a 32-bit, rendered as 8 hex chars. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Stable stringify: object keys sorted, so key order can't change the hash. */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  const walk = (v: unknown): string => {
    if (v === null) return 'null'
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
    if (typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v)
    if (typeof v === 'undefined' || typeof v === 'function') return 'null'
    if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (seen.has(o)) return '"[circular]"'
      seen.add(o)
      const keys = Object.keys(o).sort()
      return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(o[k])}`).join(',')}}`
    }
    return 'null'
  }
  return walk(value)
}

export const hashObject = (value: unknown): string => fnv1a(stableStringify(value))

/**
 * Hash a candle series. Samples the head, tail and a stride through the middle
 * so multi-million-bar datasets hash in milliseconds while still detecting any
 * realistic edit.
 */
export function hashCandles(
  candles: { t: number; o: number; h: number; l: number; c: number }[],
): string {
  const n = candles.length
  if (n === 0) return fnv1a('empty')
  const parts: string[] = [String(n)]
  const stride = Math.max(1, Math.floor(n / 512))
  for (let i = 0; i < n; i += stride) {
    const c = candles[i]
    parts.push(`${c.t}|${c.o}|${c.h}|${c.l}|${c.c}`)
  }
  const last = candles[n - 1]
  parts.push(`${last.t}|${last.o}|${last.h}|${last.l}|${last.c}`)
  return fnv1a(parts.join(';'))
}

let counter = 0
/** Deterministic-per-session id. Not a UUID; uniqueness within a run is enough. */
export function nextId(prefix: string): string {
  counter += 1
  return `${prefix}_${counter.toString(36)}`
}

export function resetIdCounter(): void {
  counter = 0
}
