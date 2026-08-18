import type { StrategyConfig } from '../types'
import type { StrategySpec } from './types'
import { compileSpec, specStrategyId } from './compile'
import { hydrateConfig, registerStrategy } from '../strategy/registry'
import { validateSpec, specIsRunnable } from './validate'

/**
 * Resolve a StrategyConfig into something the engine can run.
 *
 * Spec configs carry their spec as JSON, so this works in ANY context — main
 * thread, worker, or a future server — without shared registry state. The spec
 * is compiled (and registered) on first sight, then reused.
 */

export function resolveStrategyConfig(cfg: StrategyConfig): StrategyConfig {
  if (!cfg.spec) return hydrateConfig(cfg)

  const spec = cfg.spec as StrategySpec
  const issues = validateSpec(spec)
  if (!specIsRunnable(issues)) {
    const first = issues.find((i) => i.severity === 'ERROR')
    throw new Error(
      `Spec "${spec.name}" is not runnable: ${first?.path}: ${first?.message}`,
    )
  }

  const strategy = compileSpec(spec)
  registerStrategy(strategy)
  return {
    ...cfg,
    strategyId: strategy.id,
    params: { ...strategy.defaults, ...cfg.params },
  }
}

/** Build a runnable StrategyConfig from a spec. */
export function makeSpecConfig(spec: StrategySpec): StrategyConfig {
  return {
    id: `cfg_${spec.id}_${Date.now().toString(36)}`,
    strategyId: specStrategyId(spec),
    name: spec.name,
    params: {},
    spec,
    lockedAt: null,
    forwardTestFrom: null,
    version: spec.meta.specVersion,
    createdAt: Date.now(),
  }
}
