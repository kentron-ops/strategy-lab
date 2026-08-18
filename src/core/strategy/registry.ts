import type { Strategy, StrategyConfig } from '../types'
import simultaneousHedge from './simultaneousHedge'
import ocoBreakout from './ocoBreakout'
import breakoutContinuation from './breakoutContinuation'

/**
 * Strategy registry. Configs are serializable JSON referencing a strategy by id,
 * so a saved config survives a rebuild and can be exported between devices.
 */

const ALL: Strategy[] = [simultaneousHedge, ocoBreakout, breakoutContinuation]

const BY_ID = new Map<string, Strategy>(ALL.map((s) => [s.id, s]))

/**
 * Compiled-spec strategies register here at resolve time. Kept separate from
 * the built-ins so listStrategies() stays the stable, curated list.
 */
const DYNAMIC = new Map<string, Strategy>()

export const listStrategies = (): Strategy[] => ALL

export function registerStrategy(s: Strategy): void {
  DYNAMIC.set(s.id, s)
}

export function getStrategy(id: string): Strategy {
  const s = BY_ID.get(id) ?? DYNAMIC.get(id)
  if (!s) {
    throw new Error(
      `Unknown strategy "${id}". Known: ${[...BY_ID.keys()].join(', ')} (+${DYNAMIC.size} compiled).`,
    )
  }
  return s
}

export function hasStrategy(id: string): boolean {
  return BY_ID.has(id)
}

let configSeq = 0

export function makeConfig(
  strategyId: string,
  overrides: Record<string, number | string | boolean> = {},
  name?: string,
): StrategyConfig {
  const s = getStrategy(strategyId)
  configSeq += 1
  return {
    id: `cfg_${strategyId}_${configSeq}`,
    strategyId,
    name: name ?? s.name,
    params: { ...s.defaults, ...overrides },
    lockedAt: null,
    forwardTestFrom: null,
    version: 1,
    createdAt: Date.now(),
  }
}

/**
 * Fill in any params missing from a stored config with the strategy's current
 * defaults, so adding a parameter later does not break saved work.
 */
export function hydrateConfig(cfg: StrategyConfig): StrategyConfig {
  const s = getStrategy(cfg.strategyId)
  return { ...cfg, params: { ...s.defaults, ...cfg.params } }
}

/**
 * Lock a config after it passes out-of-sample (§13). From then on it is only
 * judged on data after the lock date, which removes the temptation to re-fit.
 */
export function lockConfig(cfg: StrategyConfig, forwardFrom: number): StrategyConfig {
  return { ...cfg, lockedAt: Date.now(), forwardTestFrom: forwardFrom }
}

export function paramsOf(cfg: StrategyConfig): Record<string, number | string | boolean> {
  return hydrateConfig(cfg).params
}
