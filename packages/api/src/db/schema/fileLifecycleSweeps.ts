/**
 * `file_lifecycle_sweeps` — one run of the file lifecycle sweep
 * (`services/fileLifecycle.worker.ts`, ADR 0041 D5), which is at once its
 * LEASE and its REPORT.
 *
 * - **Lease.** A run is claimed by inserting a `running` row under a
 *   transaction-scoped advisory lock, so of every API task polling at once
 *   exactly one sweeps; a row whose `lease_expires_at` passed while still
 *   `running` (its task died) is retired as `abandoned` by the next claim.
 * - **Schedule and backoff.** The next run is due one interval after the last
 *   `completed` one, or after an exponential backoff on consecutive `failed`
 *   ones — read from these rows, so every task agrees without a clock of its own.
 * - **Report.** `counts` says, per step, how many files are DUE and how many
 *   were acted on; `samples` names up to a hundred of each with their owner and
 *   dates. In `report` mode nothing is acted on: the rows are what an operator
 *   reviews before switching the sweep to `enforce`
 *   (`GET /assets/admin/lifecycle/sweeps`, staff only).
 *
 * Kept 90 days (`db/expiry.ts`).
 */

import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';

/** `report` counts and samples; `enforce` also acts. (`off` never writes a row.) */
export const FILE_LIFECYCLE_SWEEP_MODES = ['report', 'enforce'] as const;
export type FileLifecycleSweepMode = (typeof FILE_LIFECYCLE_SWEEP_MODES)[number];

export const FILE_LIFECYCLE_SWEEP_STATUSES = [
  'running',
  'completed',
  'failed',
  'abandoned',
] as const;
export type FileLifecycleSweepStatus = (typeof FILE_LIFECYCLE_SWEEP_STATUSES)[number];

export const FILE_LIFECYCLE_SWEEP_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/** Per step: files due at the run's instant, and what was done with them. */
export interface FileLifecycleStepCounts {
  /** Files that meet the step's condition (in `report` mode: what it WOULD act on). */
  due: number;
  /** Acted on in this run (always 0 in `report` mode; at most the batch size). */
  acted: number;
  /** Due, but the conditional write found it changed (re-referenced, restored…). */
  skipped: number;
  /** An action that threw; retried by the next run. */
  failed: number;
  /** Step-specific extras, e.g. a stale upload that still holds an object. */
  [extra: string]: number;
}

/** One file named in a report. */
export interface FileLifecycleSample {
  fileId: string;
  ownerApplicationId?: string | null;
  ownerUserId?: string | null;
  size: number;
  /** The instant the step's clock started: unreferenced, trashed, or created. */
  since: string | null;
}

export const fileLifecycleSweeps = pgTable(
  'file_lifecycle_sweeps',
  {
    id: generatedId(),
    mode: text({ enum: FILE_LIFECYCLE_SWEEP_MODES }).notNull(),
    status: text({ enum: FILE_LIFECYCLE_SWEEP_STATUSES }).notNull().default('running'),
    /** `<host>:<pid>:<random>` of the task that claimed it. */
    claimedBy: text().notNull(),
    leaseExpiresAt: timestamptz().notNull(),
    /** The run's clock: every cutoff is measured from here (an injected clock in tests). */
    startedAt: timestamptz().notNull(),
    finishedAt: timestamptz(),
    counts: jsonb().$type<Record<string, FileLifecycleStepCounts>>().notNull().default({}),
    samples: jsonb().$type<Record<string, FileLifecycleSample[]>>().notNull().default({}),
    /** The error a `failed` run stopped on, truncated. Never a file's name or content. */
    error: text(),
    createdAt: createdAt(),
  },
  (t) => [
    // The claim reads the newest runs; the report lists them newest first.
    index('file_lifecycle_sweeps_started_at_idx').on(t.startedAt.desc()),
    // The 90-day retention sweep's range scan (`db/expiry.ts`).
    index('file_lifecycle_sweeps_created_at_idx').on(t.createdAt),
    check(
      'file_lifecycle_sweeps_mode_check',
      sql`${t.mode} in (${sql.raw(FILE_LIFECYCLE_SWEEP_MODES.map((value) => `'${value}'`).join(', '))})`,
    ),
    check(
      'file_lifecycle_sweeps_status_check',
      sql`${t.status} in (${sql.raw(
        FILE_LIFECYCLE_SWEEP_STATUSES.map((value) => `'${value}'`).join(', '),
      )})`,
    ),
  ],
);
