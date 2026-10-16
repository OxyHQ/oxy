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
  assertAppliedMigrations,
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
export {
  type EnsureExtensionsOptions,
  type RequiredExtension,
  ensureExtensions,
} from './extensions';
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
export {
  DEFAULT_LOCK_ATTEMPTS,
  DEFAULT_LOCK_RETRY_BASE_DELAY_MS,
  DEFAULT_LOCK_RETRY_MAX_DELAY_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  LOCK_NOT_AVAILABLE,
  MAX_STATEMENT_TIMEOUT_SECONDS,
  isLockContention,
  lockRetryDelayMs,
  readMigrationStatementTimeouts,
  statementTimeoutMarkerLine,
  type MigrationTimeoutReadResult,
} from './locks';
