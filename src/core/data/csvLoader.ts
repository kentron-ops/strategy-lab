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

/**
 * Column aliases.
 *
 * `t` is a single combined timestamp. `d` and `tm` are the SEPARATE date and
 * time columns MetaTrader writes; when both appear they are joined before
 * parsing. Headers are lower-cased and stripped of the angle brackets MT5
 * uses (`<DATE>` → `date`) before matching.
 */
const CANDIDATES: Record<string, string[]> = {
  t: ['timestamp', 'datetime', 'date_time', 'open_time', 'gmt time', 'local time'],
  d: ['date'],
  tm: ['time'],
  o: ['open', 'o', 'bid open', 'openprice'],
  h: ['high', 'h', 'bid high', 'highprice'],
  l: ['low', 'l', 'bid low', 'lowprice'],
  c: ['close', 'c', 'bid close', 'closeprice', 'last'],
  v: ['volume', 'vol', 'v', 'tickvol', 'tick volume', 'tickvolume', 'real volume'],
}

/** A bare date with no time-of-day, e.g. 2024.01.02 or 2024-01-02. */
const DATE_ONLY = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/
/** A bare time of day, e.g. 00:00 or 13:30:00. */
const TIME_ONLY = /^\d{1,2}:\d{2}(:\d{2})?$/

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
  const lower = headers.map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/^"|"$/g, '')
      .replace(/^<|>$/g, ''), // MT5 writes <DATE>, <TICKVOL>, …
  )
  const map: Record<string, number> = {}
  for (const [key, names] of Object.entries(CANDIDATES)) {
    let idx = lower.findIndex((h) => names.includes(h))
    if (idx === -1) idx = lower.findIndex((h) => names.some((n) => h.startsWith(n)))
    if (idx !== -1) map[key] = idx
  }
  // A lone date or time column IS the timestamp; only a genuine pair needs
  // joining. Collapsing here keeps the row loop simple.
  if (map.t === undefined) {
    if (map.d !== undefined && map.tm === undefined) {
      map.t = map.d
      delete map.d
    } else if (map.tm !== undefined && map.d === undefined) {
      map.t = map.tm
      delete map.tm
    }
  }
  return map
}

/**
 * Headerless MetaTrader 4 export:
 *   2024.01.02,00:00,2063.12,2064.55,2062.80,2063.90,1234
 * Date and time occupy the first two columns, so the generic positional
 * fallback (timestamp,open,high,…) would read the time as the open price.
 */
function looksLikeHeaderlessMetaTrader(row: string[]): boolean {
  return row.length >= 6 && DATE_ONLY.test(row[0] ?? '') && TIME_ONLY.test(row[1] ?? '')
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

  // YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD, optionally with a time.
  // The dot form is what MetaTrader writes (2024.01.02), so it must be
  // accepted here or every MT export lands on the DD.MM.YYYY branch above
  // and silently produces the wrong year.
  const ymd = s.match(
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
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
    const firstRow = splitRow(lines[0], sep)
    if (looksLikeHeaderlessMetaTrader(firstRow)) {
      headerMap = { d: 0, tm: 1, o: 2, h: 3, l: 4, c: 5, v: 6 }
      errors.push(
        'Read as a MetaTrader export (date, time, open, high, low, close, tick volume). Tick volume is a trade-count proxy, not real traded volume — MFI and any volume-weighted reading inherit that limitation.',
      )
    } else {
      // Generic positional fallback.
      headerMap = { t: 0, o: 1, h: 2, l: 3, c: 4, v: 5 }
      errors.push(
        'No recognisable header row. Assuming column order: timestamp, open, high, low, close, volume.',
      )
    }
    startLine = 0
  }

  const hasCombinedDateTime = headerMap.d !== undefined && headerMap.tm !== undefined
  const required = hasCombinedDateTime
    ? (['d', 'tm', 'o', 'h', 'l', 'c'] as const)
    : (['t', 'o', 'h', 'l', 'c'] as const)

  for (const key of required) {
    if (headerMap[key] === undefined) {
      return {
        dataset: null,
        errors: [
          `Could not find a "${key}" column.`,
          'Supported layouts: a single timestamp column with open/high/low/close/volume headers, ' +
            'or a MetaTrader export with separate Date and Time columns ' +
            '(MT4: 2024.01.02,00:00,open,high,low,close,tickvol — MT5: <DATE> <TIME> <OPEN> <HIGH> <LOW> <CLOSE> <TICKVOL>).',
        ],
        skipped,
        headerMap,
      }
    }
  }

  const candles: Candle[] = []
  for (let i = startLine; i < lines.length; i++) {
    const row = splitRow(lines[i], sep)
    // MetaTrader splits the stamp across two columns; join them before parsing
    // so a bar keeps its time of day instead of collapsing to midnight.
    const rawStamp = hasCombinedDateTime
      ? `${row[headerMap.d] ?? ''} ${row[headerMap.tm] ?? ''}`.trim()
      : (row[headerMap.t] ?? '')
    const t = parseTimestamp(rawStamp, opts.utcOffsetMinutes)
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
    // Reaching here usually means the file is a layout we did not recognise
    // and the positional guess was wrong. Saying only "no rows parsed" leaves
    // the user with nothing to act on, so spell out what IS supported.
    return {
      dataset: null,
      errors: [
        ...errors,
        'No rows could be parsed.',
        'Supported layouts: a header row naming timestamp/open/high/low/close/volume, ' +
          'or a MetaTrader export with separate Date and Time columns ' +
          '(MT4: 2024.01.02,00:00,open,high,low,close,tickvol — MT5: <DATE> <TIME> <OPEN> <HIGH> <LOW> <CLOSE> <TICKVOL>).',
      ],
      skipped,
      headerMap,
    }
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
