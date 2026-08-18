import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bollinger, cci, mfi } from '../indicators'
import { buildSampleDataset } from '../data/sample'
import { toCsv } from '../data/csvLoader'

/**
 * Indicator differential EXPORT.
 *
 * Writes the synthetic dataset plus this engine's Bollinger / CCI / MFI series
 * so scripts/differential/compare_indicators.py can recompute them from the
 * textbook definitions in pandas and demand agreement.
 *
 * This runs with the normal suite so the export can never go stale relative to
 * the implementation.
 */

const OUT = join(process.cwd(), 'scripts', 'differential', 'out')

const BB_PERIOD = 20
const BB_STDDEV = 2
const CCI_PERIOD = 20
const MFI_PERIOD = 14

describe('indicator differential export', () => {
  it('writes BB / CCI / MFI series for the Python reference to check', () => {
    const full = buildSampleDataset()
    const dataset = { ...full, candles: full.candles.slice(0, 3000) }
    const c = dataset.candles

    const bb = bollinger(c, BB_PERIOD, BB_STDDEV)
    const cciSeries = cci(c, CCI_PERIOD)
    const mfiSeries = mfi(c, MFI_PERIOD)

    // Sanity: each series must actually produce values, or the Python check
    // would "agree" on a column of nulls and prove nothing.
    expect(bb.middle.filter((x) => x !== null).length).toBeGreaterThan(2000)
    expect(cciSeries.filter((x) => x !== null).length).toBeGreaterThan(2000)
    expect(mfiSeries.filter((x) => x !== null).length).toBeGreaterThan(2000)

    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, 'indicator_data.csv'), toCsv(c), 'utf8')

    const fmt = (x: number | null): string => (x === null ? '' : x.toPrecision(15))
    const header = 'i,bb_middle,bb_upper,bb_lower,cci,mfi'
    const rows = c.map((_, i) =>
      [i, fmt(bb.middle[i]), fmt(bb.upper[i]), fmt(bb.lower[i]), fmt(cciSeries[i]), fmt(mfiSeries[i])].join(','),
    )
    writeFileSync(join(OUT, 'ts_indicators.csv'), [header, ...rows].join('\n'), 'utf8')

    writeFileSync(
      join(OUT, 'indicator_meta.json'),
      JSON.stringify(
        {
          bars: c.length,
          datasetHash: dataset.hash,
          params: {
            bollinger: { period: BB_PERIOD, stdDevs: BB_STDDEV, deviation: 'population (ddof=0)' },
            cci: { period: CCI_PERIOD, deviation: 'mean absolute deviation', constant: 0.015 },
            mfi: { period: MFI_PERIOD, unchangedTypicalPrice: 'contributes to neither side' },
          },
          tolerance: {
            relative: 1e-9,
            note: 'Pure arithmetic on identical inputs; only float association should differ.',
          },
        },
        null,
        2,
      ),
      'utf8',
    )
  })
})
