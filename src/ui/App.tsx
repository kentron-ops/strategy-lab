import React, { useEffect } from 'react'
import { useJournal, useLab, type ViewName } from '../state/store'
import { LabView } from './views/LabView'
import { ResultsView } from './views/ResultsView'
import { TradesView } from './views/TradesView'
import { ReplayView } from './views/ReplayView'
import { OptimizeView } from './views/OptimizeView'
import { JournalView } from './views/JournalView'
import { DataView } from './views/DataView'

const VIEWS: { key: ViewName; label: string }[] = [
  { key: 'LAB', label: 'LAB' },
  { key: 'RESULTS', label: 'RESULTS' },
  { key: 'TRADES', label: 'TRADES' },
  { key: 'REPLAY', label: 'REPLAY' },
  { key: 'OPTIMIZE', label: 'OPTIMIZE' },
  { key: 'JOURNAL', label: 'JOURNAL' },
  { key: 'DATA', label: 'DATA' },
]

export function App(): React.ReactElement {
  const s = useLab()
  const j = useJournal()

  useEffect(() => {
    void s.hydrate()
    void j.hydrate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = s.theme
  }, [s.theme])

  const active = s.activeDataset()
  const rc = s.recompute

  return (
    <div className="app">
      <header className="topbar">
        <span className="wordmark">
          STRATEGY<b>LAB</b>
        </span>
        <span className="simulation-badge">SIMULATION ONLY</span>
        <nav className="tabs">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              className={s.view === v.key ? 'active' : ''}
              onClick={() => s.setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </nav>
        <div className="top-status">
          <span>
            <span className={`dot ${rc.running ? 'busy' : rc.error ? 'bad' : 'ok'}`} />{' '}
            {rc.running
              ? `computing ${(rc.progress * 100).toFixed(0)}%`
              : rc.error
                ? 'error'
                : rc.dirty
                  ? 'stale'
                  : rc.lastDurationMs !== null
                    ? `${rc.lastDurationMs}ms`
                    : 'idle'}
          </span>
          {active && (
            <span>
              {active.symbol} · {active.timeframe}
            </span>
          )}
          <button
            className="btn small"
            onClick={() => s.setTheme(s.theme === 'dark' ? 'light' : 'dark')}
            title="Toggle light/dark"
          >
            {s.theme === 'dark' ? '☾' : '☀'}
          </button>
        </div>
      </header>

      <main className="main">
        {!s.hydrated ? (
          <div className="callout">Loading local data…</div>
        ) : (
          <>
            {s.view === 'LAB' && <LabView />}
            {s.view === 'RESULTS' && <ResultsView />}
            {s.view === 'TRADES' && <TradesView />}
            {s.view === 'REPLAY' && <ReplayView />}
            {s.view === 'OPTIMIZE' && <OptimizeView />}
            {s.view === 'JOURNAL' && <JournalView />}
            {s.view === 'DATA' && <DataView />}
          </>
        )}
      </main>

      <footer className="footer">
        <span>SIMULATION ONLY — no order is ever sent, no execution code exists in this build</span>
        <span>every probabilistic figure carries its sample size; if the interval spans zero, there is no measured edge</span>
        <span>data lives in this browser only — export a backup from DATA</span>
      </footer>
    </div>
  )
}
