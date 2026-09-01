/**
 * The PERSISTED half of the closed denial set.
 *
 * `POST /auth/session/deny/:authorizeCode` is unauthenticated, so the closed set
 * is enforced twice: once at the edge (the request schema) and once in storage
 * (this `enum`). Both now read ONE declaration — `COMMONS_DENY_REASONS` in
 * `@oxyhq/contracts` — instead of two hand-maintained copies that drift the
 * moment a value is added on one side only.
 *
 * Two things are pinned here, and the first is the reason the constant lives in
 * a contract package rather than in either consumer:
 *
 *  1. The enum RESOLVES AT MODULE LOAD. The schema definition spreads the set
 *     (`enum: [...COMMONS_DENY_REASONS, null]`), so a source for it that is not
 *     a real array at import time — e.g. a module another suite replaced with a
 *     `jest.mock` factory — throws while building the schema, taking down every
 *     suite that touches this model. Importing it from `@oxyhq/contracts` (which
 *     nothing mocks) is what keeps that impossible; this test fails loudly if the
 *     source is ever pointed back at a mockable module.
 *  2. Mongoose actually REJECTS an out-of-set value, so the storage-level
 *     guarantee is real and not just a comment.
 *
 * Uses the REAL mongoose (the global `jest.setup.cjs` mock strips schema
 * validation) — same pattern as `deviceSession.model.test.ts`.
 */

jest.mock('mongoose', () => jest.requireActual('mongoose'));

import { COMMONS_DENY_REASONS } from '@oxyhq/contracts';
import mongoose from 'mongoose';
import AuthSession from '../AuthSession';

/** The minimum a document needs so only `deniedReason` can fail validation. */
function baseSession(): Record<string, unknown> {
  return {
    sessionToken: 'session-token',
    applicationId: new mongoose.Types.ObjectId(),
    expiresAt: new Date(Date.now() + 60_000),
  };
}

describe('AuthSession.deniedReason — the persisted closed set', () => {
  it('builds its enum from the shared contract set at module load', () => {
    const path = AuthSession.schema.path('deniedReason');
    if (!(path instanceof mongoose.Schema.Types.String)) {
      throw new Error('deniedReason is expected to be a String path');
    }
    // `null` is allowed alongside the set: a request that was never denied, or
    // denied without a reason, stores null.
    expect(path.enumValues.filter((value) => value !== null)).toEqual([...COMMONS_DENY_REASONS]);
  });

  it('defaults to null (never denied)', () => {
    const doc = new AuthSession(baseSession());
    expect(doc.deniedReason).toBeNull();
  });

  it.each([...COMMONS_DENY_REASONS])('accepts the contract reason %s', (reason) => {
    const doc = new AuthSession({ ...baseSession(), deniedReason: reason });
    expect(doc.validateSync()?.errors?.deniedReason).toBeUndefined();
    expect(doc.deniedReason).toBe(reason);
  });

  it.each([
    ['free-form text', 'the app looked phishy'],
    ['an out-of-set value', 'suspicious'],
    ['an empty string', ''],
  ])('rejects %s at the storage layer', (_label, reason) => {
    const doc = new AuthSession({ ...baseSession(), deniedReason: reason });
    expect(doc.validateSync()?.errors?.deniedReason).toBeDefined();
  });
});
