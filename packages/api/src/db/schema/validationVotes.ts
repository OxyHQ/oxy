/**
 * `validation_votes` — a juror's signed verdict on a validation request.
 *
 * Ported from `models/ValidationVote.ts`. The juror signs a
 * `validation_verdict` record with their own key, bound to the request id and
 * the payload hash, so a vote cannot be forged or altered after the fact.
 * Append-only: the absence of `updated_at` is the contract.
 *
 * `UNIQUE (request_id, validator_user_id)` — one vote per juror per request.
 * `submitVote` already treats the resulting duplicate-key error as
 * `already_voted`, so the constraint is the mechanism rather than a safety net.
 *
 * `envelope` is `jsonb` for the same measured reason as `signed_records.envelope`
 * — verification re-canonicalizes from the PARSED value, so `jsonb`'s
 * normalisations are representation-only. See that module's header.
 */

import { sql } from 'drizzle-orm';
import { check, doublePrecision, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { createdAt, generatedId, inList } from '@oxyhq/db';
import { signedRecords } from './signedRecords';
import { users } from './users';
import { validationRequests } from './validationRequests';

/** A juror's answer. `abstain` counts toward participation, never toward a side. */
export const VALIDATION_VERDICTS = ['valid', 'invalid', 'abstain'] as const;

export const validationVotes = pgTable(
  'validation_votes',
  {
    id: generatedId(),
    /** `CASCADE` — a verdict on a request that no longer exists decides nothing. */
    requestId: text()
      .notNull()
      .references(() => validationRequests.id, { onDelete: 'cascade' }),
    /**
     * The juror. `CASCADE`: the vote is their signed statement, and a deleted
     * account cannot be slashed for it either — the slash path reads these rows
     * to find who endorsed a verdict later found fraudulent.
     */
    validatorUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    verdict: text({ enum: VALIDATION_VERDICTS }).notNull(),
    /** The full signed verdict envelope as submitted. */
    envelope: jsonb().$type<SignedRecordEnvelope>().notNull(),
    /** The juror's signing key — a current VM at vote time. */
    publicKey: text().notNull(),
    /**
     * Content address of the verdict envelope on the juror's own chain.
     *
     * `CASCADE` follows the proof, as on `personhood_vouches`. The same
     * `?? ''` call-site hazard applies (`validator.service.ts:295`): an empty
     * string is not a content address and the constraint now says so.
     */
    recordId: text()
      .notNull()
      .references(() => signedRecords.recordId, { onDelete: 'cascade' }),
    /** The juror's capped influence at vote time. The tally may weight by it. */
    stakeWeight: doublePrecision().notNull().default(1),

    /** Append-only: the ABSENCE of `updated_at` is the contract. */
    createdAt: createdAt(),
  },
  (t) => [
    // One vote per juror per request. Also the "have they voted yet?" lookup.
    uniqueIndex('validation_votes_request_validator_key').on(t.requestId, t.validatorUserId),
    // The tally reads every vote of one request; the compound above leads with
    // `request_id`, so no second index is needed for it. This one serves the
    // OTHER direction — "which requests has this juror voted on" — which
    // `getValidatorInbox` runs on every inbox load and Mongo could not serve.
    index('validation_votes_validator_user_id_idx').on(t.validatorUserId),

    check(
      'validation_votes_verdict_check',
      sql`${t.verdict} in (${sql.raw(inList(VALIDATION_VERDICTS))})`
    ),
    check('validation_votes_stake_weight_check', sql`${t.stakeWeight} >= 0`),
  ]
);
