import { describe, expect, it } from 'vitest'
import { parseCsv, parseTimestamp, DEFAULT_CSV_OPTIONS } from './csvLoader'

/**
 * MetaTrader import.
 *
 * Both export dialects, with and without headers, plus the failure modes a
 * user will actually hit. The load-bearing detail is that MT writes the date
 * as YYYY.MM.DD and puts the time in its own column — get either wrong and
 * every bar lands on the wrong day or at midnight, which would quietly
 * destroy every session-conditioned result downstream.
 */

const opts = { ...DEFAULT_CSV_OPTIONS, symbol: 'XAUUSD', timeframe: '30m' as const }

describe('MetaTrader timestamp parsing', () => {
  it('reads the YYYY.MM.DD date form MetaTrader writes', () => {
    expect(parseTimestamp('2024.01.02 00:30', 0)).toBe(Date.UTC(2024, 0, 2, 0, 30, 0))
    expect(parseTimestamp('2024.01.02 13:30:00', 0)).toBe(Date.UTC(2024, 0, 2, 13, 30, 0))
  })

  it('does not confuse YYYY.MM.DD with the DD.MM.YYYY broker form', () => {
    // 2024.01.02 is 2 January 2024. Read as DD.MM.YYYY it would be nonsense.
    const mt = parseTimestamp('2024.01.02', 0)
    expect(new Date(mt).getUTCFullYear()).toBe(2024)
    expect(new Date(mt).getUTCMonth()).toBe(0)
    expect(new Date(mt).getUTCDate()).toBe(2)

    // The Dukascopy-style DD.MM.YYYY form still works.
    const duka = parseTimestamp('06.01.2025 08:30:00', 0)
    expect(duka).toBe(Date.UTC(2025, 0, 6, 8, 30, 0))
  })

  it('applies the declared UTC offset to MetaTrader stamps', () => {
    // A broker on UTC+3 stamps 03:00 for what is 00:00 UTC.
    expect(parseTimestamp('2024.01.02 03:00', 180)).toBe(Date.UTC(2024, 0, 2, 0, 0, 0))
  })
})

describe('MetaTrader 4 export (headerless, comma separated)', () => {
  const mt4 = [
    '2024.01.02,00:00,2063.12,2064.55,2062.80,2063.90,1234',
    '2024.01.02,00:30,2063.90,2065.10,2063.50,2064.80,1580',
    '2024.01.02,01:00,2064.80,2066.00,2064.10,2065.55,1102',
  ].join('\n')

  it('imports without a header row', () => {
    const r = parseCsv(mt4, opts)
    expect(r.dataset).not.toBeNull()
    expect(r.dataset!.candles).toHaveLength(3)
  })

  it('combines the Date and Time columns instead of losing the time of day', () => {
    const r = parseCsv(mt4, opts)
    const c = r.dataset!.candles
    expect(c[0].t).toBe(Date.UTC(2024, 0, 2, 0, 0, 0))
    expect(c[1].t).toBe(Date.UTC(2024, 0, 2, 0, 30, 0))
    expect(c[2].t).toBe(Date.UTC(2024, 0, 2, 1, 0, 0))
    // Distinct timestamps, 30 minutes apart — not all collapsed to midnight.
    expect(c[1].t - c[0].t).toBe(30 * 60_000)
  })

  it('reads OHLC from the right columns, not shifted by the time column', () => {
    const r = parseCsv(mt4, opts)
    const c = r.dataset!.candles[0]
    expect(c.o).toBe(2063.12)
    expect(c.h).toBe(2064.55)
    expect(c.l).toBe(2062.8)
    expect(c.c).toBe(2063.9)
  })

  it('reads tick volume and says plainly that it is not real volume', () => {
    const r = parseCsv(mt4, opts)
    expect(r.dataset!.candles[0].v).toBe(1234)
    expect(r.errors.join(' ')).toMatch(/tick volume/i)
    expect(r.errors.join(' ')).toMatch(/not real traded volume/i)
  })

  it('infers M30 spacing from the bars themselves', () => {
    const r = parseCsv(mt4, { ...opts, timeframe: null })
    expect(r.dataset!.timeframe).toBe('30m')
  })
})

describe('MetaTrader 5 export (tab separated, angle-bracket headers)', () => {
  const mt5 = [
    '<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>',
    '2024.01.02\t00:00:00\t2063.12\t2064.55\t2062.80\t2063.90\t1234\t0\t25',
    '2024.01.02\t00:30:00\t2063.90\t2065.10\t2063.50\t2064.80\t1580\t0\t24',
  ].join('\n')

  it('strips the angle brackets and imports cleanly', () => {
    const r = parseCsv(mt5, opts)
    expect(r.dataset).not.toBeNull()
    expect(r.dataset!.candles).toHaveLength(2)
    expect(r.dataset!.candles[0].o).toBe(2063.12)
    expect(r.dataset!.candles[0].v).toBe(1234)
  })

  it('combines <DATE> and <TIME> correctly', () => {
    const r = parseCsv(mt5, opts)
    expect(r.dataset!.candles[0].t).toBe(Date.UTC(2024, 0, 2, 0, 0, 0))
    expect(r.dataset!.candles[1].t).toBe(Date.UTC(2024, 0, 2, 0, 30, 0))
  })

  it('produces data the validator accepts', () => {
    const r = parseCsv(mt5, opts)
    expect(r.dataset!.quality?.usable).toBe(true)
  })
})

describe('MetaTrader import failure modes are explicit', () => {
  it('names the supported layouts when the columns cannot be found', () => {
    const r = parseCsv('alpha,beta,gamma\n1,2,3', opts)
    expect(r.dataset).toBeNull()
    const msg = r.errors.join(' ')
    expect(msg).toMatch(/MetaTrader/)
    expect(msg).toMatch(/Date and Time/)
  })

  it('skips malformed rows and reports them rather than dropping them silently', () => {
    const dirty = [
      '2024.01.02,00:00,2063.12,2064.55,2062.80,2063.90,1234',
      '2024.01.02,00:30,notaprice,2065.10,2063.50,2064.80,1580',
      '2024.01.02,01:00,2064.80,2066.00,2064.10,2065.55,1102',
    ].join('\n')
    const r = parseCsv(dirty, opts)
    expect(r.dataset!.candles).toHaveLength(2)
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0].reason).toMatch(/price/)
    expect(r.errors.join(' ')).toMatch(/skipped/)
  })

  it('flags OHLC that could not have happened', () => {
    // High below the close — physically impossible, must not pass silently.
    const broken = [
      '2024.01.02,00:00,2063.12,2064.55,2062.80,2063.90,1234',
      '2024.01.02,00:30,2063.90,2060.00,2063.50,2064.80,1580',
    ].join('\n')
    const r = parseCsv(broken, opts)
    expect(r.dataset!.quality?.usable).toBe(false)
    expect(r.dataset!.quality?.issues.some((i) => i.code === 'BAD_OHLC')).toBe(true)
  })

  it('a single-column file is rejected with a clear message, not a crash', () => {
    const r = parseCsv('2024.01.02\n2024.01.03', opts)
    expect(r.dataset).toBeNull()
    expect(r.errors.length).toBeGreaterThan(0)
  })
})
