/**
 * Chain engine — verify-then-append orchestration.
 *
 * The one entry point an app's adapter calls to publish a record: it runs the
 * full {@link verifyEnvelope} state machine, computes the content address
 * (`recordId`), and hands the verified envelope to the injected
 * {@link RecordStore} to persist atomically. The store owns the durable
 * concurrency backstop (`chain_conflict` on a unique-index collision); the
 * engine owns the verification + ordering policy.
 *
 * Storage and identity are both injected, so the engine has zero knowledge of
 * Mongo/SQLite, Oxy DIDs, or any app's lexicon — exactly what makes it reusable.
 */

import type { SignedRecordEnvelope } from '@oxy.so/contracts';
import { computeRecordId } from '../envelope/recordId';
import type { VerificationMethodResolver } from '../identity/resolver';
import { verifyEnvelope, type VerifyOptions } from './verify';
import type { RecordStore } from './recordStore';
import type { AppendOutcome } from './types';

/**
 * Verify `env` and, if it passes, append it to the subject's chain.
 *
 * On a verification failure the rejection is returned WITHOUT touching the store.
 * On success the (engine-computed) `recordId` is passed to `store.append`, whose
 * own outcome — including the `chain_conflict` backstop on a concurrent-writer
 * collision — is returned verbatim.
 */
export async function verifyAndAppend(
  store: RecordStore,
  resolver: VerificationMethodResolver,
  env: SignedRecordEnvelope,
  opts: VerifyOptions = {},
): Promise<AppendOutcome> {
  const verification = await verifyEnvelope(store, resolver, env, opts);
  if (!verification.ok) {
    return verification;
  }

  const recordId = await computeRecordId(env);
  return store.append(env.subject, env, recordId);
}
