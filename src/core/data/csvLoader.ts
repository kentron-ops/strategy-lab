import type { Candle, Dataset, Timeframe } from '../types'
import { normalizeCandles, validateCandles } from './validators'
import { hashCandles } from '../util/hash'
import { inferTimeframe } from '../util/time'

/**
 * CSV import.
 *
 * Deliberately permissive about column names and separators, and deliberately
 * STRICT about timezone: an ambiguous local timestamp is interpreted using an
 * explicit offset the user chooses, and that choice is recorded on the dataset.
 * Silently guessing a timezone shifts every session-conditioned result.
 */

export interface CsvParseOptions {
  symbol: string
  /** Declared timeframe; when null it is inferred from bar spacing. */
  timeframe: Timeframe | null
  /**
   * Minutes to ADD to naive timestamps to get UTC.
   * 0 means the file is already UTC. Ignored when timestamps carry an offset.
   */
  utcOffsetMinutes: number
  source: string
}

export const DEFAULT_CSV_OPTIONS: CsvParseOptions = {
  symbol: 'XAUUSD',
  timeframe: null,
  utcOffsetMinutes: 0,
  source: 'csv',
}

export interface CsvParseResult {
  dataset: Dataset | null
  errors: string[]
  /** Rows that could not be parsed at all, with a reason. */
  skipped: { line: number; text: string; reason: string }[]
  headerMap: Record<string, number>
}

const CANDIDATES: Record<string, string[]> = {
  t: ['timestamp', 'time', 'date', 'datetime', 'date_time', 'open_time', 'gmt time', 'local time'],
  o: ['open', 'o', 'bid open', 'openprice'],
  h: ['high', 'h', 'bid high', 'highprice'],
  l: ['low', 'l', 'bid low', 'lowprice'],
  c: ['close', 'c', 'bid close', 'closeprice', 'last'],
  v: ['volume', 'vol', 'v', 'tickvol', 'tick volume'],
}

function detectSeparator(line: string): string {
  const candidates = [',', ';', '\t', '|']
  let best = ','
  let bestCount = 0
  for (const sep of candidates) {
    const count = line.split(sep).length
    if (count > bestCount) {
      bestCount = count
      best = sep
    }
  }
  return best
}

function splitRow(line: string, sep: string): string[] {
  // Handles simple quoted fields; CSVs from brokers occasionally quote dates.
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"'
        i++
      } else inQuotes = !inQuotes
    } else if (ch === sep && !inQuotes) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

function mapHeaders(headers: string[]): Record<string, number> {
  const lower = headers.map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''))
  const map: Record<string, number> = {}
  for (const [key, names] of Object.entries(CANDIDATES)) {
    let idx = lower.findIndex((h) => names.includes(h))
    if (idx === -1) idx = lower.findIndex((h) => names.some((n) => h.startsWith(n)))
    if (idx !== -1) map[key] = idx
  }
  return map
}

/**
 * Parse a timestamp. Supports epoch seconds/ms, ISO 8601, and the common
 * `YYYY-MM-DD HH:MM(:SS)` / `DD.MM.YYYY HH:MM` broker formats.
 * Returns NaN when the value cannot be read — never a silent zero.
 */
export function parseTimestamp(raw: string, utcOffsetMinutes: number): number {
  const s = raw.trim().replace(/^"|"$/g, '')
  if (!s) return NaN

  if (/^\d+$/.test(s)) {
    const num = Number(s)
    // Heuristic: 10 digits = seconds, 13 = milliseconds.
    if (s.length <= 10) return num * 1000
    if (s.length <= 13) return num
    return num / 1000
  }

  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s)
  if (hasExplicitZone) {
    const t = Date.parse(s)
    return Number.isNaN(t) ? NaN : t
  }

  // DD.MM.YYYY or DD/MM/YYYY (Dukascopy and MT exports)
  const dm = s.match(
    /^(\d{2})[./](\d{2})[./](\d{4})[ T]?(\d{2})?:?(\d{2})?:?(\d{2})?/,
  )
  if (dm) {
    const [, dd, mm, yyyy, hh = '0', mi = '0', ss = '0'] = dm
    const t = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi, +ss)
    return t - utcOffsetMinutes * 60_000
  }

  // YYYY-MM-DD HH:MM:SS  (naive — interpret with the declared offset)
  const ymd = s.match(
    /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/,
  )
  if (ymd) {
    const [, yyyy, mm, dd, hh = '0', mi = '0', ss = '0'] = ymd
    const t = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi, +ss)
    return t - utcOffsetMinutes * 60_000
  }

  const fallback = Date.parse(s)
  return Number.isNaN(fallback) ? NaN : fallback - utcOffsetMinutes * 60_000
}

function parseNumber(raw: string): number {
  const s = raw.trim().replace(/^"|"$/g, '').replace(/\s/g, '')
  if (!s) return NaN
  // Tolerate "1 234,56" style decimals when there is no ambiguity.
  if (s.includes(',') && !s.includes('.')) return Number(s.replace(',', '.'))
  return Number(s.replace(/,/g, ''))
}

export function parseCsv(text: string, opts: CsvParseOptions): CsvParseResult {
  const errors: string[] = []
  const skipped: { line: number; text: string; reason: string }[] = []

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) {
    return {
      dataset: null,
      errors: ['File has no data rows.'],
      skipped,
      headerMap: {},
    }
  }

  const sep = detectSeparator(lines[0])
  let headerMap = mapHeaders(splitRow(lines[0], sep))
  let startLine = 1

  const hasHeader = headerMap.o !== undefined && headerMap.c !== undefined
  if (!hasHeader) {
    // Assume the canonical positional order when there is no recognisable header.
    headerMap = { t: 0, o: 1, h: 2, l: 3, c: 4, v: 5 }
    startLine = 0
    errors.push(
      'No recognisable header row. Assuming column order: timestamp, open, high, low, close, volume.',
    )
  }

  for (const key of ['t', 'o', 'h', 'l', 'c'] as const) {
    if (headerMap[key] === undefined) {
      return {
        dataset: null,
        errors: [
          `Could not find a "${key}" column. Expected headers like: timestamp, open, high, low, close, volume.`,
        ],
        skipped,
        headerMap,
      }
    }
  }

  const candles: Candle[] = []
  for (let i = startLine; i < lines.length; i++) {
    const row = splitRow(lines[i], sep)
    const t = parseTimestamp(row[headerMap.t] ?? '', opts.utcOffsetMinutes)
    if (!Number.isFinite(t)) {
      skipped.push({ line: i + 1, text: lines[i].slice(0, 120), reason: 'unparseable timestamp' })
      continue
    }
    const o = parseNumber(row[headerMap.o] ?? '')
    const h = parseNumber(row[headerMap.h] ?? '')
    const l = parseNumber(row[headerMap.l] ?? '')
    const c = parseNumber(row[headerMap.c] ?? '')
    if (![o, h, l, c].every(Number.isFinite)) {
      skipped.push({ line: i + 1, text: lines[i].slice(0, 120), reason: 'unparseable price' })
      continue
    }
    const vRaw = headerMap.v !== undefined ? parseNumber(row[headerMap.v] ?? '') : NaN
    const candle: Candle = { t, o, h, l, c }
    if (Number.isFinite(vRaw)) candle.v = vRaw
    candles.push(candle)
  }

  if (!candles.length) {
    return { dataset: null, errors: [...errors, 'No rows could be parsed.'], skipped, headerMap }
  }

  const normalized = normalizeCandles(candles)
  const tf = opts.timeframe ?? inferTimeframe(normalized.map((c) => c.t))
  if (!tf) {
    errors.push(
      'Could not infer a timeframe from bar spacing. Set it explicitly before backtesting.',
    )
  }

  const quality = validateCandles(normalized, opts.timeframe)
  const hash = hashCandles(normalized)

  const dataset: Dataset = {
    id: `ds_${hash}`,
    symbol: opts.symbol,
    timeframe: tf ?? '5m',
    candles: normalized,
    timezone:
      opts.utcOffsetMinutes === 0
        ? 'UTC'
        : `UTC${opts.utcOffsetMinutes > 0 ? '+' : '-'}${Math.abs(opts.utcOffsetMinutes / 60)}`,
    source: opts.source,
    hash,
    createdAt: Date.now(),
    quality,
  }

  if (skipped.length) {
    errors.push(`${skipped.length} row(s) skipped — see the skipped list.`)
  }

  return { dataset, errors, skipped, headerMap }
}

/** Serialize back to CSV, for export and round-trip tests. */
export function toCsv(candles: Candle[]): string {
  const head = 'timestamp,open,high,low,close,volume'
  const rows = candles.map(
    (c) => `${new Date(c.t).toISOString()},${c.o},${c.h},${c.l},${c.c},${c.v ?? ''}`,
  )
  return [head, ...rows].join('\n')
}
