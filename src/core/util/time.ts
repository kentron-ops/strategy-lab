import type { Session, Timeframe } from '../types'
import { TF_MS } from '../types'

/**
 * Time helpers. Everything internal is epoch-ms UTC; timezone interpretation
 * happens once at import and is recorded on the dataset.
 */

export function utcHour(t: number): number {
  return new Date(t).getUTCHours()
}

export function utcDayKey(t: number): string {
  const d = new Date(t)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`
}

/** 0 = Sunday. */
export function utcDayOfWeek(t: number): number {
  return new Date(t).getUTCDay()
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Which session a timestamp falls in, given UTC hour bounds [start, end).
 * Bounds may wrap past midnight (e.g. [21, 24] or [22, 3]).
 */
export function sessionOf(
  t: number,
  bounds: Record<Session, [number, number]>,
): Session {
  const h = utcHour(t)
  const order: Session[] = ['ASIA', 'LONDON', 'NY', 'OFF']
  for (const s of order) {
    const [from, to] = bounds[s]
    if (from <= to ? h >= from && h < to : h >= from || h < to) return s
  }
  return 'OFF'
}

/** Infer the dominant bar spacing, then snap it to a known timeframe. */
export function inferTimeframe(times: number[]): Timeframe | null {
  if (times.length < 3) return null
  const counts = new Map<number, number>()
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1]
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  let bestDelta = 0
  let bestCount = 0
  for (const [d, c] of counts) {
    if (c > bestCount) {
      bestCount = c
      bestDelta = d
    }
  }
  if (!bestDelta) return null
  for (const [tf, ms] of Object.entries(TF_MS)) {
    if (ms === bestDelta) return tf as Timeframe
  }
  return null
}

/** Floor a timestamp to the start of its bucket for the given timeframe. */
export function floorToTimeframe(t: number, tf: Timeframe): number {
  const ms = TF_MS[tf]
  return Math.floor(t / ms) * ms
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = m / 60
  if (h < 48) return `${h.toFixed(1)}h`
  return `${(h / 24).toFixed(1)}d`
}

export function formatDate(t: number): string {
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toISOString().replace('T', ' ').slice(0, 16) + 'Z'
}
