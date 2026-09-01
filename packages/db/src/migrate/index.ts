export {
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
  MigrationsNotCurrentError,
  UnreachableMigrationError,
  assertPostgresMigrationsCurrent,
  highWaterMillis,
  pendingEntries,
  planLedgerRun,
  readAppliedMillis,
  readJournal,
  readLastAppliedMillis,
  unreachableEntries,
  type JournalEntry,
} from './ledger';
export {
  type AppliedMigrationRow,
  type JournalEntryWithHash,
  type LedgerComparison,
  type LedgerHashMismatch,
  compareLedger,
  formatLedgerComparison,
  readAppliedRows,
  readJournalWithHashes,
  verifyMigrationLedger,
} from './verify';
export {
  MissingMigrationTargetError,
  WrongMigrationTargetError,
  assertMigrationTarget,
  readTargetDatabase,
} from './targetDatabase';
export { type RequiredExtension, ensureExtensions } from './extensions';
export { type RunMigrationsOptions, runMigrations } from './runner';
export {
  DEPLOY_PHASES,
  MIGRATION_RUNS,
  POST_PHASE_GREP_PATTERN,
  phaseMarkerLine,
  planMigrationRun,
  readMigrationPhases,
  type DeployPhase,
  type MigrationPhaseReadResult,
  type MigrationRun,
  type MigrationRunPlan,
} from './phases';
