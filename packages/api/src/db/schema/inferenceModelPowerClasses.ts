/**
 * `inference_model_power_classes` — the REVIEWED capability tier of a model
 * line, which the power-level routing profiles choose from.
 *
 * ## Reviewed data, never inferred
 *
 * A class is a claim about how capable a model is, and Oxy sells requests on
 * the strength of it. So every row cites a public benchmark source
 * (`evidence_source`, `evidence_url`, `evidence_summary`) and a reviewer, and no
 * code path derives a class from a model's NAME: `-mini`, `-pro` or `-flash`
 * mean different things at different publishers, and a substring match would
 * put a strong model in `instant` or a weak one in `pro` without anyone having
 * looked. A model with no row here is callable by name and chosen by no level.
 *
 * ## Keyed by canonical model id, not by row id
 *
 * `model_id` is the `<publisher>/<model>` a customer writes, matched against
 * `inference_models.model_id`. Not a foreign key, deliberately: the Kaana sync
 * creates and revives model rows on its own cadence, and a reviewed class must
 * be writable BEFORE the line is first observed (and must survive the line
 * being retired and revived). A class for a line the catalogue does not carry
 * selects nothing. The class follows the model LINE; a revision that changes
 * behaviour materially is a reason to re-review the row.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { MODEL_ID_CHECK_PATTERN } from './inferenceSlug';

/** `modelPowerClassSchema` in the contract, cheapest first. */
export const MODEL_POWER_CLASSES = ['instant', 'medium', 'high', 'pro', 'ultra'] as const;

export type ModelPowerClassValue = (typeof MODEL_POWER_CLASSES)[number];

export const inferenceModelPowerClasses = pgTable(
  'inference_model_power_classes',
  {
    /** Canonical `<publisher>/<model>` — never a revision. */
    modelId: text().primaryKey(),
    powerClass: text({ enum: MODEL_POWER_CLASSES }).notNull(),
    /** The benchmark and its version, e.g. `artificial-analysis-intelligence-index/v4.3.2`. */
    evidenceSource: text().notNull(),
    evidenceUrl: text().notNull(),
    /** What the source said, in one line: score, rank, effort setting. */
    evidenceSummary: text().notNull(),
    reviewedAt: timestamptz().notNull(),
    /** Who reviewed it — a person or change reference, audit only. */
    reviewedBy: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'inference_model_power_classes_model_id_format',
      sql`${t.modelId} ~ ${sql.raw(MODEL_ID_CHECK_PATTERN)}`,
    ),
    check(
      'inference_model_power_classes_class_check',
      sql`${t.powerClass} in (${sql.raw(inList(MODEL_POWER_CLASSES))})`,
    ),
    check(
      'inference_model_power_classes_evidence_check',
      sql`length(btrim(${t.evidenceSource})) > 0
        and ${t.evidenceUrl} ~ '^https://'
        and length(btrim(${t.evidenceSummary})) > 0
        and length(btrim(${t.reviewedBy})) > 0`,
    ),
  ],
);

export type InferenceModelPowerClassRow = typeof inferenceModelPowerClasses.$inferSelect;
