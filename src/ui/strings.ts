/**
 * UI string dictionary (V2: English only for now, i18n-ready).
 *
 * Every user-facing string added from V2 onward lives here, keyed, so a
 * Persian (or any) locale later means adding a second dictionary — not
 * touching components. Keep keys stable; keep values honest.
 */

export type Locale = 'en'

const en = {
  // Prover
  proverTitle: 'EDGE PROVER',
  proverIntro:
    'Runs the current strategy through seven gates and the statistical guards. The output is a verdict about EVIDENCE — never a promise about the future.',
  proverRun: 'RUN THE 7 GATES',
  proverRunning: 'Proving…',
  proverVerdictProven: 'PROVEN',
  proverVerdictInsufficient: 'INSUFFICIENT EVIDENCE',
  proverVerdictNotProven: 'NOT PROVEN',
  proverTrialsLabel: 'configurations tried',
  proverTrialsHelp:
    'How many parameter combinations have been evaluated against this strategy family (manual edits, sweeps, everything). The more you tried, the more impressive a result must be before it can be believed — this count feeds the trials penalty directly.',
  proverGrade: 'confidence grade',
  proverGradeHelp:
    'A = every gate passed including the forward test, with a trials-adjusted p-value under 1%. B = gates 1–6 passed, forward test still pending. C = evidence too thin to judge. D = failed.',
  acceptIfTitle: 'Pre-registered thresholds (AcceptIf)',
  acceptIfHelp:
    'Set these BEFORE testing. The Prover holds you to them and reports every revision — moving the goalposts after seeing results is recorded, not hidden.',
  acceptIfMinTrades: 'Minimum trades',
  acceptIfMinExpectancy: 'Minimum expectancy (R)',
  acceptIfRevisions: (n: number): string =>
    n === 0 ? 'never revised' : `revised ${n} time${n === 1 ? '' : 's'} — the Prover reports this`,
  saveToLibrary: 'SAVE TO LIBRARY',
  savedToLibrary: 'Saved.',

  // Guards
  guardBootstrap: 'Bootstrap expectancy CI',
  guardTrials: 'Multiple-testing penalty',
  guardRandom: 'vs random entry',
  guardBuyHold: 'vs buy & hold',
  guardOutliers: 'Outlier dependence',

  // Library
  libraryTitle: 'LIBRARY',
  libraryIntro:
    'Strategies that have been through the Prover, stored with their evidence. An entry without evidence is a draft, not a result.',
  libraryEmpty:
    'Nothing here yet. Build a strategy in LAB, prove it in PROVER, then save it here with its evidence card.',
  libraryLoad: 'LOAD',
  libraryDelete: 'DELETE',
  libraryNoEvidence: 'draft — never proven',
  libraryScatterX: 'max drawdown %',
  libraryScatterY: 'expectancy (R)',

  // Spec builder
  specTitle: 'STRATEGY',
  specPresets: 'Presets',
  specBuiltins: 'Reference implementations',
  specSaved: 'Library specs',
  specExport: 'EXPORT JSON',
  specImport: 'IMPORT JSON',
  specImportBad: (msg: string): string => `Import failed: ${msg}`,
  specValidationErrors: 'This spec cannot run:',
  specEntryMode: 'Entry mode',
  specDirection: 'Direction',
  specStop: 'Stop',
  specTarget: 'Target',
  specTimeout: 'Timeout (bars)',
  specRules: 'Entry rules',
  specFilters: 'Filters',
  specAddRule: '+ rule',
  specRemove: 'remove',
  specSessionFilter: 'Sessions',
  specHtfFilter: 'Require higher-timeframe alignment',

  // show the math
  showMath: 'show the math',
  mathFormula: 'Formula',
  mathInputs: 'Exact inputs',
  mathNote:
    'Every displayed number is engine output over the loaded data. Export the ledger from TRADES and recompute this by hand — it must match.',

  simulationOnly: 'SIMULATION ONLY',
} as const

export type Strings = typeof en

const dictionaries: Record<Locale, Strings> = { en }

let current: Locale = 'en'

export const setLocale = (l: Locale): void => {
  current = l
}

export const STR: Strings = new Proxy(en, {
  get(_t, prop: string) {
    return dictionaries[current][prop as keyof Strings]
  },
}) as Strings
