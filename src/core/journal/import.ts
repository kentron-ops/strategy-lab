import type { Side } from '../types'
import type { BehaviorTag, JournalEntry } from './types'
import { parseTimestamp } from '../data/csvLoader'

/**
 * Journal import.
 *
 * Manual-only journals die of friction, so import is the default path and the
 * parser is forgiving about column naming. What it is NOT forgiving about is
 * inventing values: a row missing an entry price is reported, never defaulted.
 */

export interface JournalImportOptions {
  symbol: string
  utcOffsetMinutes: number
  /** Applied when the file has no stop column, so R can still be computed. */
  defaultStopDistance: number | null
}

export const DEFAULT_JOURNAL_IMPORT: JournalImportOptions = {
  symbol: 'XAUUSD',
  utcOffsetMinutes: 0,
  defaultStopDistance: null,
}

export interface JournalImportResult {
  entries: JournalEntry[]
  errors: string[]
  skipped: { line: number; text: string; reason: string }[]
}

const FIELDS: Record<string, string[]> = {
  symbol: ['symbol', 'instrument', 'pair', 'ticker', 'market'],
  side: ['side', 'direction', 'type', 'buy/sell', 'action'],
  qty: ['qty', 'quantity', 'size', 'volume', 'lots', 'units'],
  entryTime: ['entrytime', 'entry time', 'opentime', 'open time', 'entrydate', 'opened', 'time'],
  entryPrice: ['entryprice', 'entry price', 'openprice', 'open price', 'entry', 'price'],
  exitTime: ['exittime', 'exit time', 'closetime', 'close time', 'exitdate', 'closed'],
  exitPrice: ['exitprice', 'exit price', 'closeprice', 'close price', 'exit'],
  stopLoss: ['stoploss', 'stop loss', 'stop', 'sl', 's/l'],
  takeProfit: ['takeprofit', 'take profit', 'target', 'tp', 't/p'],
  fees: ['fees', 'commission', 'cost', 'costs', 'swap', 'charges'],
  setupTag: ['setup', 'tag', 'strategy', 'system'],
  notes: ['notes', 'note', 'comment', 'comments', 'reason'],
  plannedEntry: ['plannedentry', 'planned entry', 'intended entry'],
  plannedStop: ['plannedstop', 'planned stop', 'intended stop'],
}

function detectSeparator(line: string): string {
  let best = ','
  let bestCount = 0
  for (const sep of [',', ';', '\t', '|']) {
    const count = line.split(sep).length
    if (count > bestCount) {
      bestCount = count
      best = sep
    }
  }
  return best
}

function splitRow(line: string, sep: string): string[] {
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
  for (const [field, names] of Object.entries(FIELDS)) {
    const idx = lower.findIndex((h) => names.includes(h))
    if (idx !== -1) map[field] = idx
  }
  return map
}

function parseSide(raw: string): Side | null {
  const s = raw.trim().toLowerCase()
  if (!s) return null
  if (['long', 'buy', 'b', 'l', '1'].includes(s)) return 'LONG'
  if (['short', 'sell', 's', '-1'].includes(s)) return 'SHORT'
  return null
}

function parseNum(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const s = raw.trim().replace(/[^0-9.,\-+eE]/g, '')
  if (!s) return null
  const n = Number(s.includes(',') && !s.includes('.') ? s.replace(',', '.') : s.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

let seq = 0

export function importJournalCsv(
  text: string,
  opts: JournalImportOptions = DEFAULT_JOURNAL_IMPORT,
): JournalImportResult {
  const errors: string[] = []
  const skipped: { line: number; text: string; reason: string }[] = []
  const entries: JournalEntry[] = []

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) {
    return { entries, errors: ['File has no data rows.'], skipped }
  }

  const sep = detectSeparator(lines[0])
  const map = mapHeaders(splitRow(lines[0], sep))

  const required = ['entryTime', 'entryPrice', 'exitPrice']
  const missing = required.filter((f) => map[f] === undefined)
  if (missing.length) {
    return {
      entries,
      errors: [
        `Missing required column(s): ${missing.join(', ')}. Expected headers such as: entry time, entry price, exit time, exit price, side, qty, stop loss, fees.`,
      ],
      skipped,
    }
  }

  for (let i = 1; i < lines.length; i++) {
    const row = splitRow(lines[i], sep)
    const get = (f: string): string | undefined =>
      map[f] !== undefined ? row[map[f]] : undefined

    const entryTime = parseTimestamp(get('entryTime') ?? '', opts.utcOffsetMinutes)
    if (!Number.isFinite(entryTime)) {
      skipped.push({ line: i + 1, text: lines[i].slice(0, 120), reason: 'unreadable entry time' })
      continue
    }

    const entryPrice = parseNum(get('entryPrice'))
    const exitPrice = parseNum(get('exitPrice'))
    if (entryPrice === null || exitPrice === null) {
      skipped.push({ line: i + 1, text: lines[i].slice(0, 120), reason: 'missing entry or exit price' })
      continue
    }

    const exitRaw = get('exitTime')
    const exitTime = exitRaw ? parseTimestamp(exitRaw, opts.utcOffsetMinutes) : entryTime
    const side = parseSide(get('side') ?? '')
    if (!side) {
      skipped.push({ line: i + 1, text: lines[i].slice(0, 120), reason: 'unrecognised side (expected long/short or buy/sell)' })
      continue
    }

    const qty = parseNum(get('qty')) ?? 1
    let stopLoss = parseNum(get('stopLoss'))
    if (stopLoss === null && opts.defaultStopDistance !== null) {
      stopLoss =
        side === 'LONG'
          ? entryPrice - opts.defaultStopDistance
          : entryPrice + opts.defaultStopDistance
    }

    seq += 1
    entries.push({
      id: `je_${Date.now().toString(36)}_${seq}`,
      symbol: (get('symbol') || opts.symbol).trim(),
      side,
      qty,
      entryTime,
      entryPrice,
      exitTime: Number.isFinite(exitTime) ? exitTime : entryTime,
      exitPrice,
      stopLoss,
      takeProfit: parseNum(get('takeProfit')),
      fees: parseNum(get('fees')) ?? 0,
      plannedEntry: parseNum(get('plannedEntry')),
      plannedStop: parseNum(get('plannedStop')),
      plannedRiskPercent: null,
      setupTag: (get('setupTag') ?? '').trim(),
      notes: (get('notes') ?? '').trim(),
      strategyConfigId: null,
      manualTags: [] as BehaviorTag[],
      createdAt: Date.now(),
      source: 'csv',
    })
  }

  if (skipped.length) {
    errors.push(
      `${skipped.length} row(s) could not be read and were skipped — they are listed rather than guessed at.`,
    )
  }
  if (!entries.length) errors.push('No rows could be imported.')

  return { entries, errors, skipped }
}

export function journalToCsv(entries: JournalEntry[]): string {
  const head = [
    'symbol', 'side', 'qty', 'entryTime', 'entryPrice', 'exitTime', 'exitPrice',
    'stopLoss', 'takeProfit', 'fees', 'setup', 'notes',
  ].join(',')
  const rows = entries.map((e) =>
    [
      e.symbol,
      e.side,
      e.qty,
      new Date(e.entryTime).toISOString(),
      e.entryPrice,
      new Date(e.exitTime).toISOString(),
      e.exitPrice,
      e.stopLoss ?? '',
      e.takeProfit ?? '',
      e.fees,
      csvEscape(e.setupTag),
      csvEscape(e.notes),
    ].join(','),
  )
  return [head, ...rows].join('\n')
}

function csvEscape(s: string): string {
  if (!s) return ''
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Build an entry from the quick-capture form. */
export function makeEntry(partial: Partial<JournalEntry>): JournalEntry {
  seq += 1
  const now = Date.now()
  return {
    id: `je_${now.toString(36)}_${seq}`,
    symbol: 'XAUUSD',
    side: 'LONG',
    qty: 1,
    entryTime: now,
    entryPrice: 0,
    exitTime: now,
    exitPrice: 0,
    stopLoss: null,
    takeProfit: null,
    fees: 0,
    plannedEntry: null,
    plannedStop: null,
    plannedRiskPercent: null,
    setupTag: '',
    notes: '',
    strategyConfigId: null,
    manualTags: [],
    createdAt: now,
    source: 'manual',
    ...partial,
  }
}
