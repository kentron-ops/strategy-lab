import { describe, expect, it } from 'vitest'
import type { Candle } from '../types'
import { resolveBar, touchesStop, touchesTarget, updateExcursions } from './intrabar'

const bar = (o: number, h: number, l: number, c: number): Candle => ({
  t: 0,
  o,
  h,
  l,
  c,
})

describe('intrabar resolution', () => {
  const longLevels = { side: 'LONG' as const, stopLoss: 95, takeProfit: 110 }

  it('reports nothing when neither level is touched', () => {
    const out = resolveBar(bar(100, 104, 97, 101), longLevels, 'CONSERVATIVE')
    expect(out.kind).toBe('NONE')
  })

  it('takes the only level that was touched', () => {
    const stopOnly = resolveBar(bar(100, 104, 94, 96), longLevels, 'OPTIMISTIC')
    expect(stopOnly).toMatchObject({ kind: 'EXIT', reason: 'STOP', ambiguous: false })

    const targetOnly = resolveBar(bar(100, 112, 97, 111), longLevels, 'CONSERVATIVE')
    expect(targetOnly).toMatchObject({ kind: 'EXIT', reason: 'TARGET', ambiguous: false })
  })

  describe('when one bar touches BOTH levels', () => {
    const contested = bar(100, 112, 94, 105)

    it('CONSERVATIVE assumes the adverse fill and flags it', () => {
      const out = resolveBar(contested, longLevels, 'CONSERVATIVE')
      expect(out).toMatchObject({ kind: 'EXIT', reason: 'STOP', ambiguous: true })
    })

    it('OPTIMISTIC assumes the target and flags it just as loudly', () => {
      const out = resolveBar(contested, longLevels, 'OPTIMISTIC')
      expect(out).toMatchObject({ kind: 'EXIT', reason: 'TARGET', ambiguous: true })
    })

    it('SKIP_AMBIGUOUS refuses to guess at all', () => {
      const out = resolveBar(contested, longLevels, 'SKIP_AMBIGUOUS')
      expect(out.kind).toBe('AMBIGUOUS_SKIP')
    })

    it('finer data resolves it exactly, and the result is still flagged as contested', () => {
      // Sub-bars show the target was reached first.
      const fine = [bar(100, 111, 99, 110), bar(110, 111, 94, 95)]
      const out = resolveBar(contested, longLevels, 'CONSERVATIVE', fine)
      expect(out).toMatchObject({ kind: 'EXIT', reason: 'TARGET', ambiguous: true })

      // Reverse the order and the answer flips — the policy is not consulted.
      const fineStopFirst = [bar(100, 104, 94, 95), bar(95, 112, 95, 110)]
      const out2 = resolveBar(contested, longLevels, 'OPTIMISTIC', fineStopFirst)
      expect(out2).toMatchObject({ kind: 'EXIT', reason: 'STOP', ambiguous: true })
    })
  })

  describe('gaps', () => {
    it('a bar opening below the stop fills at the open, not at the stop', () => {
      const out = resolveBar(bar(90, 92, 88, 91), longLevels, 'CONSERVATIVE')
      expect(out).toMatchObject({
        kind: 'EXIT',
        reason: 'STOP',
        price: 90,
        gapped: true,
        ambiguous: false,
      })
    })

    it('a bar opening above the target fills at the open', () => {
      const out = resolveBar(bar(115, 118, 113, 117), longLevels, 'CONSERVATIVE')
      expect(out).toMatchObject({ kind: 'EXIT', reason: 'TARGET', price: 115, gapped: true })
    })

    it('a gap through the stop is NOT treated as ambiguous even if the bar also spans the target', () => {
      const out = resolveBar(bar(90, 115, 88, 100), longLevels, 'CONSERVATIVE')
      expect(out).toMatchObject({ reason: 'STOP', gapped: true, ambiguous: false })
    })
  })

  describe('shorts are the mirror image', () => {
    const shortLevels = { side: 'SHORT' as const, stopLoss: 105, takeProfit: 90 }

    it('stops out when price rises through the stop', () => {
      const out = resolveBar(bar(100, 106, 98, 104), shortLevels, 'CONSERVATIVE')
      expect(out).toMatchObject({ kind: 'EXIT', reason: 'STOP' })
    })

    it('targets when price falls through the target', () => {
      const out = resolveBar(bar(100, 101, 89, 91), shortLevels, 'CONSERVATIVE')
      expect(out).toMatchObject({ kind: 'EXIT', reason: 'TARGET' })
    })

    it('is contested when the bar spans both', () => {
      const out = resolveBar(bar(100, 106, 89, 95), shortLevels, 'CONSERVATIVE')
      expect(out).toMatchObject({ reason: 'STOP', ambiguous: true })
    })
  })

  it('a position with no target can only ever be stopped', () => {
    const out = resolveBar(
      bar(100, 200, 97, 199),
      { side: 'LONG', stopLoss: 95, takeProfit: null },
      'CONSERVATIVE',
    )
    expect(out.kind).toBe('NONE')
    expect(touchesTarget(bar(100, 200, 97, 199), 'LONG', null)).toBe(false)
  })

  it('touch helpers treat the level itself as touched', () => {
    expect(touchesStop(bar(100, 104, 95, 101), 'LONG', 95)).toBe(true)
    expect(touchesStop(bar(100, 104, 95.01, 101), 'LONG', 95)).toBe(false)
  })
})

describe('excursions', () => {
  it('tracks the best and worst points reached, in R', () => {
    // Entry 100, stop 95 → 1R = 5.
    let mfe = 0
    let mae = 0
    const step = (b: Candle): void => {
      const out = updateExcursions(b, 'LONG', 100, 5, mfe, mae)
      mfe = out.mfeR
      mae = out.maeR
    }
    step(bar(100, 105, 98, 104)) // +1R best, −0.4R worst
    expect(mfe).toBeCloseTo(1, 10)
    expect(mae).toBeCloseTo(0.4, 10)

    step(bar(104, 107.5, 103, 107)) // best improves to +1.5R
    expect(mfe).toBeCloseTo(1.5, 10)
    expect(mae).toBeCloseTo(0.4, 10) // worst does not improve back

    step(bar(107, 108, 96, 97)) // worst deepens to −0.8R
    expect(mfe).toBeCloseTo(1.6, 10)
    expect(mae).toBeCloseTo(0.8, 10)
  })

  it('is direction-aware for shorts', () => {
    const out = updateExcursions(bar(100, 103, 90, 92), 'SHORT', 100, 5, 0, 0)
    expect(out.mfeR).toBeCloseTo(2, 10) // fell to 90 = +2R for a short
    expect(out.maeR).toBeCloseTo(0.6, 10) // rose to 103 = −0.6R
  })
})
