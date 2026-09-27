/**
 * Centralized queue identifiers and scheduling constants for the BullMQ-backed
 * background-job system.
 *
 * Every queue name, repeatable scheduler id, and job name lives here so there
 * are no magic strings or magic numbers scattered across the codebase. Changing
 * a scheduler id is a deliberate, reviewable act because doing so creates a NEW
 * repeatable schedule rather than updating the existing one.
 */

/**
 * Stable BullMQ queue names. The key namespace (`oxy-api:`) keeps these keys
 * distinct from the cache keys that share the same Valkey/Redis instance.
 */
export const QUEUE_NAMES = {
  /** Email housekeeping: snoozed messages, due reminders, scheduled sends. */
  EMAIL_MAINTENANCE: 'oxy-api-email-maintenance',
  /** One job per outbound delivery attempt; see `emailDelivery.queue.ts`. */
  EMAIL_DELIVERY: 'oxy-api-email-delivery',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Stable repeatable-job scheduler ids. These MUST remain constant across boots
 * and replicas: BullMQ's `upsertJobScheduler` treats the id as the schedule's
 * identity, so a stable id means re-registering on every boot/replica updates
 * the single existing schedule instead of creating duplicates.
 */
export const JOB_SCHEDULER_IDS = {
  EMAIL_MAINTENANCE: 'email-maintenance-tick',
} as const;

/**
 * Stable job names for jobs produced by the schedulers above. Workers match on
 * these names.
 */
export const JOB_NAMES = {
  EMAIL_MAINTENANCE_TICK: 'email-maintenance-tick',
} as const;

/**
 * Interval for the email-maintenance repeatable job. Mirrors the legacy
 * in-process cron cadence (one minute) so behaviour is unchanged.
 */
export const EMAIL_MAINTENANCE_INTERVAL_MS = 60_000;

/**
 * How many completed/failed job records BullMQ retains for the email-maintenance
 * job. Bounded so a long-running queue does not accumulate unbounded history in
 * Redis.
 */
export const COMPLETED_JOBS_RETENTION = 50;
export const FAILED_JOBS_RETENTION = 100;
