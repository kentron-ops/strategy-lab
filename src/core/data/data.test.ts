import { describe, expect, it } from 'vitest'
import { parseCsv, parseTimestamp, toCsv, DEFAULT_CSV_OPTIONS } from './csvLoader'
import { normalizeCandles, validateCandles } from './validators'
import { resampleCandles, resampleDataset } from './resample'
import { buildSampleDataset, generateSampleCandles } from './sample'
import { makeDataset, zigzag } from '../testing/fixtures'
import type { Candle } from '../types'

describe('timestamp parsing', () => {
  it('reads epoch seconds and milliseconds', () => {
    expect(parseTimestamp('1735948800', 0)).toBe(1735948800000)
    expect(parseTimestamp('1735948800000', 0)).toBe(1735948800000)
  })

  it('reads ISO with an explicit zone and ignores the offset setting', () => {
    const t = parseTimestamp('2025-01-06T08:00:00Z', 120)
    expect(t).toBe(Date.UTC(2025, 0, 6, 8, 0, 0))
  })

  it('applies the declared offset to naive timestamps', () => {
    const utc = parseTimestamp('2025-01-06 08:00:00', 0)
    const plus2 = parseTimestamp('2025-01-06 08:00:00', 120)
    expect(utc).toBe(Date.UTC(2025, 0, 6, 8, 0, 0))
    // A bar stamped 08:00 in UTC+2 is 06:00 UTC.
    expect(plus2).toBe(Date.UTC(2025, 0, 6, 6, 0, 0))
  })

  it('reads the DD.MM.YYYY broker format', () => {
    expect(parseTimestamp('06.01.2025 08:30:00', 0)).toBe(Date.UTC(2025, 0, 6, 8, 30, 0))
  })

  it('returns NaN rather than a plausible zero for junk', () => {
    expect(Number.isNaN(parseTimestamp('not a date', 0))).toBe(true)
    expect(Number.isNaN(parseTimestamp('', 0))).toBe(true)
  })
})

describe('CSV import', () => {
  const csv = [
    'timestamp,open,high,low,close,volume',
    '2025-01-06T00:00:00Z,100,101,99,100.5,1000',
    '2025-01-06T00:05:00Z,100.5,102,100,101.5,1200',
    '2025-01-06T00:10:00Z,101.5,103,101,102,900',
  ].join('\n')

  it('parses a clean file', () => {
    const r = parseCsv(csv, { ...DEFAULT_CSV_OPTIONS, timeframe: '5m' })
    expect(r.dataset).not.toBeNull()
    expect(r.dataset?.candles).toHaveLength(3)
    expect(r.dataset?.candles[0].c).toBe(100.5)
    expect(r.dataset?.timeframe).toBe('5m')
    expect(r.dataset?.quality?.usable).toBe(true)
  })

  it('infers the timeframe from bar spacing', () => {
    const r = parseCsv(csv, { ...DEFAULT_CSV_OPTIONS, timeframe: null })
    expect(r.dataset?.timeframe).toBe('5m')
  })

  it('handles semicolon separators and reordered columns', () => {
    const alt = [
      'Date;Close;Open;High;Low',
      '2025-01-06T00:00:00Z;100.5;100;101;99',
      '2025-01-06T00:05:00Z;101.5;100.5;102;100',
    ].join('\n')
    const r = parseCsv(alt, DEFAULT_CSV_OPTIONS)
    expect(r.dataset?.candles).toHaveLength(2)
    expect(r.dataset?.candles[0].o).toBe(100)
    expect(r.dataset?.candles[0].c).toBe(100.5)
  })

  it('skips unparseable rows and reports them instead of dropping them silently', () => {
    const dirty = csv + '\ngarbage,rows,here,x,y,z'
    const r = parseCsv(dirty, DEFAULT_CSV_OPTIONS)
    expect(r.skipped).toHaveLength(1)
    expect(r.errors.join(' ')).toMatch(/skipped/)
    expect(r.dataset?.candles).toHaveLength(3)
  })

  it('refuses a file with no recognisable price columns', () => {
    const r = parseCsv('a,b\n1,2', DEFAULT_CSV_OPTIONS)
    expect(r.dataset).toBeNull()
    expect(r.errors[0]).toMatch(/column/)
  })

  it('round-trips through toCsv', () => {
    const r1 = parseCsv(csv, DEFAULT_CSV_OPTIONS)
    const r2 = parseCsv(toCsv(r1.dataset!.candles), DEFAULT_CSV_OPTIONS)
    expect(r2.dataset?.candles.map((c) => [c.t, c.o, c.h, c.l, c.c])).toEqual(
      r1.dataset?.candles.map((c) => [c.t, c.o, c.h, c.l, c.c]),
    )
  })

  it('produces a content hash that changes when a single price changes', () => {
    const a = parseCsv(csv, DEFAULT_CSV_OPTIONS).dataset!
    const b = parseCsv(csv.replace('102,100,101.5', '102,100,101.6'), DEFAULT_CSV_OPTIONS).dataset!
    expect(b.hash).not.toBe(a.hash)
  })
})

describe('validation', () => {
  const good: Candle[] = [
    { t: 0, o: 100, h: 101, l: 99, c: 100.5 },
    { t: 300000, o: 100.5, h: 102, l: 100, c: 101.5 },
  ]

  it('passes clean data', () => {
    const r = validateCandles(good, '5m')
    expect(r.usable).toBe(true)
    expect(r.issues.filter((i) => i.severity === 'ERROR')).toHaveLength(0)
  })

  it('catches a high below the close', () => {
    const bad = [...good, { t: 600000, o: 101, h: 100, l: 99, c: 103 }]
    const r = validateCandles(bad, '5m')
    expect(r.usable).toBe(false)
    expect(r.issues.some((i) => i.code === 'BAD_OHLC')).toBe(true)
  })

  it('catches duplicate and out-of-order timestamps', () => {
    const dup = validateCandles([good[0], { ...good[1], t: 0 }], '5m')
    expect(dup.issues.some((i) => i.code === 'DUPLICATE_TIMESTAMP')).toBe(true)

    const rev = validateCandles([good[1], { ...good[0], t: 0 }], '5m')
    expect(rev.issues.some((i) => i.code === 'OUT_OF_ORDER')).toBe(true)
  })

  it('catches negative prices', () => {
    const r = validateCandles([{ t: 0, o: -1, h: 1, l: -2, c: 0.5 }], '5m')
    expect(r.usable).toBe(false)
  })

  it('flags gaps as a warning, not a silent jump', () => {
    const gapped: Candle[] = [
      { t: 0, o: 100, h: 101, l: 99, c: 100 },
      { t: 300000, o: 100, h: 101, l: 99, c: 100 },
      { t: 600000, o: 100, h: 101, l: 99, c: 100 },
      { t: 3000000, o: 100, h: 101, l: 99, c: 100 },
    ]
    const r = validateCandles(gapped, '5m')
    expect(r.issues.some((i) => i.code === 'GAP' || i.code === 'WEEKEND_GAP')).toBe(true)
  })

  it('normalizes by sorting and de-duplicating', () => {
    const messy: Candle[] = [
      { t: 600000, o: 3, h: 3, l: 3, c: 3 },
      { t: 0, o: 1, h: 1, l: 1, c: 1 },
      { t: 0, o: 2, h: 2, l: 2, c: 2 },
    ]
    const out = normalizeCandles(messy)
    expect(out.map((c) => c.t)).toEqual([0, 600000])
    expect(out[0].o).toBe(2) // last duplicate wins
  })
})

describe('resampling', () => {
  const base = zigzag(120, { timeframe: '5m' })

  it('aggregates OHLC correctly', () => {
    const hourly = resampleCandles(base, '1h')
    expect(hourly.length).toBeGreaterThan(0)
    const first = hourly[0]
    const members = base.filter((c) => c.t >= first.t && c.t < first.t + 3600000)
    expect(first.o).toBe(members[0].o)
    expect(first.c).toBe(members[members.length - 1].c)
    expect(first.h).toBe(Math.max(...members.map((m) => m.h)))
    expect(first.l).toBe(Math.min(...members.map((m) => m.l)))
    expect(first.v).toBe(members.reduce((a, m) => a + (m.v ?? 0), 0))
  })

  it('refuses to invent detail by downsampling', () => {
    const ds = makeDataset(base, '1h')
    const out = resampleDataset(ds, '5m')
    expect(out.dataset).toBeNull()
    expect(out.error).toMatch(/cannot be invented/i)
  })

  it('returns the same dataset when the target matches', () => {
    const ds = makeDataset(base, '5m')
    expect(resampleDataset(ds, '5m').dataset).toBe(ds)
  })
})

describe('synthetic sample data', () => {
  it('is deterministic for a given seed', () => {
    const a = generateSampleCandles({ ...{ symbol: 'X', timeframe: '5m', bars: 200, startPrice: 2000, seed: 7, driftPerBar: 0, baseVolatility: 0.0003, startTime: Date.UTC(2025, 0, 6) } })
    const b = generateSampleCandles({ ...{ symbol: 'X', timeframe: '5m', bars: 200, startPrice: 2000, seed: 7, driftPerBar: 0, baseVolatility: 0.0003, startTime: Date.UTC(2025, 0, 6) } })
    expect(b).toEqual(a)
  })

  it('passes its own validator', () => {
    const ds = buildSampleDataset()
    expect(ds.quality?.usable).toBe(true)
  })

  it('is labelled as not real data, everywhere it can be', () => {
    const ds = buildSampleDataset()
    expect(ds.source).toMatch(/NOT REAL MARKET DATA/)
    expect(ds.symbol).toMatch(/SYNTHETIC/)
  })

  it('skips weekends', () => {
    const ds = buildSampleDataset()
    const saturdays = ds.candles.filter((c) => new Date(c.t).getUTCDay() === 6)
    expect(saturdays).toHaveLength(0)
  })
})
