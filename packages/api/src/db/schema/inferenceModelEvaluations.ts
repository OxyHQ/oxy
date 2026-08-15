/**
 * `inference_model_evaluations` — one published evaluation result for one
 * revision.
 *
 * A child table rather than `jsonb` on the revision, per `CONVENTIONS.md`: an
 * array of ENTITIES with a known shape becomes a real table with real foreign
 * keys, because a `jsonb` array cannot be joined, constrained or usefully
 * indexed — and this one is read by suite and by metric.
 *
 * It hangs off the REVISION, not the model. An eval measures specific weights;
 * attached to a model line it would silently become a claim about whatever
 * shipped most recently, which is the exact conflation ADR 0008 exists to stop.
 *
 * ## The score is a string
 *
 * `modelEvaluationResultSchema` carries `score` as text, and so does this. An
 * eval score is PUBLISHED TEXT — `88.7`, `1284 (Elo)`, `pass@1 0.62` — not a
 * number this system does arithmetic on. Storing it as `numeric` would force a
 * lossy parse at ingest and invent a precision the publisher never claimed.
 */

import { pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { inferenceModelRevisions } from './inferenceModelRevisions';

export const inferenceModelEvaluations = pgTable(
  'inference_model_evaluations',
  {
    id: generatedId(),

    /**
     * `CASCADE`: an eval result for a revision that no longer exists describes
     * nothing. Unlike a review of a delisted app, there is no independent
     * subject left to attach it to.
     */
    modelRevisionId: text()
      .notNull()
      .references(() => inferenceModelRevisions.id, { onDelete: 'cascade' }),

    /** The benchmark suite, e.g. `mmlu-pro`, `swe-bench-verified`. */
    suite: text().notNull(),
    /** What was measured within it, e.g. `accuracy`, `resolved`. */
    metric: text().notNull(),
    /** The published figure, verbatim. */
    score: text().notNull(),

    evaluatedAt: timestamptz(),
    reportUrl: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * One score per `(revision, suite, metric)`. Enforced here rather than
     * checked in a route, because two concurrent ingests pass any check and
     * only a constraint stops the second — and two disagreeing scores for one
     * metric is a catalogue that cannot be quoted.
     *
     * This unique index also serves the page's read (every eval of one
     * revision), so no separate `model_revision_id` index is declared: a btree
     * answers any leading prefix, and a redundant index is one
     * `CONVENTIONS.md` says to drop.
     */
    unique('inference_model_evaluations_revision_suite_metric_key').on(
      t.modelRevisionId,
      t.suite,
      t.metric
    ),
  ]
);

export type InferenceModelEvaluationRow = typeof inferenceModelEvaluations.$inferSelect;
