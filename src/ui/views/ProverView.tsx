import React from 'react'
import { useLab } from '../../state/store'
import { STR } from '../strings'
import { Badge, Callout, Section, Tip, fmtNum } from '../components/bits'
import type { GateResult } from '../../core/prover/prover'
import type { StrategySpec } from '../../core/spec/types'

/**
 * PROVER — run the 7 gates + statistical guards on the current strategy.
 * The verdict speaks about evidence over the loaded data, never about the future.
 */

export function ProverView(): React.ReactElement {
  const s = useLab()
  const dataset = s.activeDataset()
  const proof = s.proof
  const proving = s.proving

  const spec = s.strategyConfig.spec as StrategySpec | undefined

  return (
    <>
      <Section title={STR.proverTitle}>
        <p className="muted">{STR.proverIntro}</p>

        <div className="row wrap" style={{ gap: 16, alignItems: 'flex-end' }}>
          <div>
            <div className="label">
              <Tip text={STR.acceptIfHelp}>{STR.acceptIfTitle}</Tip>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <label className="field">
                <span>{STR.acceptIfMinTrades}</span>
                <input
                  type="number"
                  min={5}
                  value={s.acceptIf.minTrades}
                  onChange={(e) => s.setAcceptIf({ minTrades: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                <span>{STR.acceptIfMinExpectancy}</span>
                <input
                  type="number"
                  step={0.01}
                  value={s.acceptIf.minExpectancyR}
                  onChange={(e) => s.setAcceptIf({ minExpectancyR: Number(e.target.value) })}
                />
              </label>
            </div>
            <div className="muted small">{STR.acceptIfRevisions(s.acceptIf.revisions)}</div>
          </div>

          <div>
            <div className="label">
              <Tip text={STR.proverTrialsHelp}>{STR.proverTrialsLabel}</Tip>
            </div>
            <div className="big-number">{s.currentTrials().toLocaleString()}</div>
          </div>

          <button
            className="btn primary"
            disabled={!dataset || proving.running}
            onClick={() => void s.runProver()}
          >
            {proving.running
              ? `${STR.proverRunning} ${proving.stage} ${(proving.progress * 100).toFixed(0)}%`
              : STR.proverRun}
          </button>
        </div>

        {proving.error && <Callout kind="error">{proving.error}</Callout>}
        {!dataset && <Callout>Load a dataset in DATA first.</Callout>}
      </Section>

      {proof && (
        <>
          <Section
            title="VERDICT"
            right={
              <>
                <Badge
                  kind={
                    proof.verdict === 'PROVEN'
                      ? 'good'
                      : proof.verdict === 'NOT_PROVEN'
                        ? 'bad'
                        : 'warn'
                  }
                >
                  {proof.verdict === 'PROVEN'
                    ? STR.proverVerdictProven
                    : proof.verdict === 'NOT_PROVEN'
                      ? STR.proverVerdictNotProven
                      : STR.proverVerdictInsufficient}
                </Badge>
                <Tip text={STR.proverGradeHelp}>
                  <Badge kind={proof.grade === 'A' || proof.grade === 'B' ? 'good' : 'warn'}>
                    {STR.proverGrade}: {proof.grade}
                  </Badge>
                </Tip>
              </>
            }
          >
            <p>{proof.headline}</p>
            <div className="gate-grid">
              {proof.gates.map((g) => (
                <GateChip key={g.key} gate={g} />
              ))}
            </div>
            {spec && proof.verdict !== 'NOT_PROVEN' && (
              <button className="btn" onClick={() => void s.saveToLibrary(spec, proof)}>
                {STR.saveToLibrary}
              </button>
            )}
            {!spec && (
              <p className="muted small">
                Built-in reference strategies are not saved to the Library — express the idea as a
                spec in LAB to keep it with its evidence.
              </p>
            )}
          </Section>

          <Section title="STATISTICAL GUARDS">
            <div className="grid metrics">
              <GuardTile
                label={STR.guardBootstrap}
                value={`${fmtNum(proof.guards.bootstrap.point, 3)}R`}
                sub={`CI ${fmtNum(proof.guards.bootstrap.low, 3)} … ${fmtNum(proof.guards.bootstrap.high, 3)} · n=${proof.guards.bootstrap.n}`}
                ok={proof.guards.bootstrap.low > 0}
                help={`Bootstrap resampling of the per-trade R series, ${proof.guards.bootstrap.iterations} iterations. If this interval touches zero there is no measured edge, whatever the headline says.`}
              />
              <GuardTile
                label={STR.guardTrials}
                value={`p = ${proof.guards.bootstrap.pValueAdjusted.toFixed(4)}`}
                sub={`raw p ${proof.guards.bootstrap.pValue.toFixed(4)} · ${proof.guards.trials} trials (Šidák)`}
                ok={proof.guards.bootstrap.pValueAdjusted < 0.05}
                help={`The probability that at least one of ${proof.guards.trials} tried configurations would look this good by pure luck. This is the single most important guard against self-deception.`}
              />
              <GuardTile
                label={STR.guardRandom}
                value={
                  Number.isFinite(proof.guards.randomBenchmark.candidatePercentile)
                    ? `beats ${(proof.guards.randomBenchmark.candidatePercentile * 100).toFixed(0)}%`
                    : '—'
                }
                sub={`${proof.guards.randomBenchmark.runs} random runs, same exits & risk`}
                ok={proof.guards.randomBenchmark.passed}
                help={proof.guards.randomBenchmark.note}
              />
              <GuardTile
                label={STR.guardBuyHold}
                value={`${fmtNum(proof.guards.buyAndHold.returnPct, 1)}%`}
                sub="full period, no costs, no stop"
                ok={true}
                help={proof.guards.buyAndHold.note}
              />
              <GuardTile
                label={STR.guardOutliers}
                value={`${fmtNum(proof.guards.outliers.expectancyRWithoutTop2, 3)}R`}
                sub="expectancy without the 2 best trades"
                ok={proof.guards.outliers.survives}
                help={proof.guards.outliers.note}
              />
              <GuardTile
                label="AcceptIf"
                value={proof.guards.acceptIfHeld ? 'held' : 'not met'}
                sub={`≥${proof.guards.acceptIf.minTrades} trades, ≥${proof.guards.acceptIf.minExpectancyR}R · ${STR.acceptIfRevisions(proof.guards.acceptIf.revisions)}`}
                ok={proof.guards.acceptIfHeld}
                help={STR.acceptIfHelp}
              />
            </div>
            {proof.warnings.length > 0 && (
              <Callout kind="error">
                {proof.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </Callout>
            )}
          </Section>
        </>
      )}
    </>
  )
}

function GateChip({ gate }: { gate: GateResult }): React.ReactElement {
  const kind =
    gate.status === 'PASS'
      ? 'good'
      : gate.status === 'FAIL'
        ? 'bad'
        : gate.status === 'PENDING'
          ? 'warn'
          : 'plain'
  return (
    <div className={`gate gate-${gate.status.toLowerCase()}`}>
      <div className="row" style={{ gap: 8 }}>
        <Badge kind={kind}>{gate.status}</Badge>
        <b>
          {gate.id}. {gate.name}
        </b>
      </div>
      <p className="small">{gate.summary}</p>
      {Object.keys(gate.numbers).length > 0 && (
        <div className="muted small mono">
          {Object.entries(gate.numbers)
            .map(([k, v]) => `${k}=${v}`)
            .join(' · ')}
        </div>
      )}
    </div>
  )
}

function GuardTile({
  label,
  value,
  sub,
  ok,
  help,
}: {
  label: string
  value: string
  sub: string
  ok: boolean
  help: string
}): React.ReactElement {
  return (
    <div className="metric">
      <div className="label">
        <Tip text={help}>{label}</Tip>
      </div>
      <div className={`value ${ok ? 'pos' : 'neg'}`}>{value}</div>
      <div className="sub">{sub}</div>
    </div>
  )
}
