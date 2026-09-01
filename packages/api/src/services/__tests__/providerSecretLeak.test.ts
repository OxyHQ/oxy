/**
 * The mutation test for the BYOK leak assertions (issue #972 workstream 10).
 *
 * `inferenceProviderConnection.service.test.ts` opens with the assertion the
 * whole workstream exists for — a credential handed to `createProviderConnection`
 * appears in nothing it returns, stores or audits — and its header has always
 * CITED this file as the proof that those checks can go red. This file did not
 * exist. A citation to a missing file is the most expensive kind of missing
 * evidence, because it reads as measured: the next reader follows the reference
 * instead of re-deriving it, and stops at a name.
 *
 * ## What is mutated, exactly
 *
 * `toProviderConnection` is a pure function of a row, so there is no way to make
 * it leak except by giving it something to copy. Each case below plants a
 * credential in its INPUT — in the stored row, or in the audit trail — and then
 * runs the REAL serializer, the REAL contract parse and the REAL audit read over
 * it. Nothing here re-implements the code under test: a hand-written imitation of
 * the serializer would measure the imitation, and a local copy of the search
 * would measure a copy, which is why `containsDeep` is imported from the module
 * the assertions themselves import.
 *
 * ## What each block establishes
 *
 *  1. The checks go RED on a real leak — three of them, one per surface the
 *     sibling covers (the DTO, the DTO serialized, the stored row, the trail).
 *     One of those leaks can no longer be PLANTED in the database: `secret_ref`
 *     used to accept a spliced credential and migration `0054` closed the
 *     grammar, so that case now asserts the two refusals AND hands the walk the
 *     same row in memory. A check whose situation became unbuildable still has to
 *     be shown to work, or "no leak found" and "this walk finds nothing" go back
 *     to looking identical.
 *  2. Two of the most obvious serializer leaks never reach a check at all: the
 *     contract REFUSES them. Asserting the refusal is what stops a later reader
 *     relaxing the 12-character `keyPrefix` cap or the `.strict()` as tidying.
 *  3. The checks are not vacuous — green on the unmutated connection, and the
 *     walk demonstrably descends rather than stopping at the top level.
 *  4. Where the walk is BLIND, stated as an assertion rather than a caveat, so
 *     nobody mistakes it for the control it is not.
 *
 * Every fixture owns its identifiers; nothing here reads a sibling file's rows.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { providerConnectionSchema } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { inferenceProviderConnectionAuditEvents } from '../../db/schema/inferenceProviderConnectionAuditEvents';
import { inferenceProviderConnections } from '../../db/schema/inferenceProviderConnections';
import { inferenceProviders } from '../../db/schema/inferenceProviders';
import { users } from '../../db/schema/users';
import {
  createProviderConnection,
  listProviderConnectionAuditEvents,
  toProviderConnection,
} from '../inferenceProviderConnection.service';
import { ProviderSecretValue, type ProviderSecretStore } from '../providerSecretStore';
import { containsDeep } from '../secretLeakProbe';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** Keeps what it is given, so the credential really does pass through. */
class FakeSecretStore implements ProviderSecretStore {
  readonly name = 'secretsmanager' as const;
  readonly written = new Map<string, string>();

  async put(reference: string, secret: ProviderSecretValue): Promise<void> {
    this.written.set(reference, secret.reveal());
  }

  async destroy(reference: string): Promise<void> {
    this.written.delete(reference);
  }
}

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

interface Fixture {
  /** The credential every assertion hunts for. */
  readonly plaintext: string;
  readonly connectionId: string;
  readonly applicationId: string;
  readonly accountId: string;
}

/**
 * One real, application-scoped connection created through the real service.
 *
 * Application-scoped rather than account-scoped so the DTO has a value that
 * exists ONLY at depth two (`scope.applicationId`) — that is what the descent
 * control below needs, and an account-scoped DTO repeats its account id at the
 * top level, where a walk that never recursed would find it.
 */
async function seedConnection(): Promise<Fixture> {
  const tag = suffix();
  const [account] = await getDb()
    .insert(users)
    .values({ username: `leak-${tag}`, email: `leak-${tag}@example.test` })
    .returning({ id: users.id });
  const [application] = await getDb()
    .insert(applications)
    .values({ name: `Leak ${tag}`, ownerAccountId: account.id })
    .returning({ id: applications.id });

  const slug = `leak${tag}`;
  await getDb().insert(inferenceProviders).values({
    slug,
    displayName: 'Fixture Provider',
    kind: 'customer_byok',
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
    byokTermsAcknowledgementRequired: false,
  });

  const plaintext = `sk-live-${randomUUID()}${randomUUID().replace(/-/g, '')}`;
  const created = await createProviderConnection(
    {
      provider: slug,
      ownerAccountId: account.id,
      scopeKind: 'application',
      applicationId: application.id,
      environment: 'production',
      secret: new ProviderSecretValue(plaintext),
      acknowledgeProviderTerms: false,
      actor: { kind: 'user', userId: account.id },
    },
    new FakeSecretStore()
  );
  if (created.status !== 'created') throw new Error(created.status);

  return {
    plaintext,
    connectionId: created.connection.connectionId,
    applicationId: application.id,
    accountId: account.id,
  };
}

/**
 * Assert a write is refused by a NAMED constraint.
 *
 * The table carries thirteen CHECKs and they all answer with SQLSTATE 23514, so
 * "it threw" would be satisfied by tripping the partition rule, a typo in a
 * column, or a missing fixture. Drizzle wraps the driver error, so the fields
 * live on the `cause` — the same walk `db/schema/__tests__` does.
 */
async function expectRefusedBy(work: Promise<unknown>, constraint: string): Promise<void> {
  try {
    await work;
  } catch (error) {
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      const name: unknown = Reflect.get(current, 'constraint_name');
      if (typeof name === 'string') {
        expect(name).toBe(constraint);
        return;
      }
    }
    throw error;
  }
  throw new Error(`expected ${constraint} to refuse the write, but it succeeded`);
}

async function readRow(connectionId: string) {
  const [row] = await getDb()
    .select()
    .from(inferenceProviderConnections)
    .where(eq(inferenceProviderConnections.id, connectionId));
  return row;
}

/* -------------------------------------------------------------------------- */

describe('the leak assertions go red on a serializer that leaks', () => {
  /**
   * The leak `secret_ref` used to allow, and the two things that now refuse it.
   *
   * `secret_ref` is the only column copied to the DTO verbatim, and it USED to be
   * the one place a credential could sit in a stored row: both guards constrained
   * the SHAPE of the locator and neither constrained what could be put in front of
   * it, so a credential spliced in after the store name satisfied
   * `^(vault|kms|ssm|secretsmanager):[A-Za-z0-9/_.:@-]+$` AND still ended with
   * `/<environment>/<account>/<id>`. Measured against a real Postgres: the write
   * landed, the parse succeeded, and this assertion was the only thing that
   * refused. `providerSecretReferenceSchema` claimed otherwise in a comment.
   *
   * Migration `0054` closed the grammar and the contract now requires the
   * reference to name this connection, so the leak is refused twice before any
   * check runs. Both refusals are asserted here, in the order a producer would
   * meet them — and then the walk is handed the same row IN MEMORY, so "the check
   * would catch it" stays a measurement rather than becoming an inference from a
   * situation that can no longer be built.
   */
  it('is refused by the column and by the contract, and would be caught by the walk', async () => {
    const { plaintext, connectionId } = await seedConnection();
    const clean = await readRow(connectionId);

    const colon = clean.secretRef.indexOf(':');
    const leakingRef = `${clean.secretRef.slice(0, colon + 1)}${plaintext}/${clean.secretRef.slice(colon + 1)}`;
    // Still inside its own partition: what refuses it below is the grammar, not
    // the partition rule, which this value satisfies exactly as it always did.
    expect(leakingRef.endsWith(`/production/${clean.ownerAccountId}/${connectionId}`)).toBe(true);

    await expectRefusedBy(
      getDb()
        .update(inferenceProviderConnections)
        .set({ secretRef: leakingRef })
        .where(eq(inferenceProviderConnections.id, connectionId)),
      'inference_provider_connections_secret_ref_format'
    );

    // The refusal is the database's, not a silent no-op: the row still holds the
    // reference the service wrote.
    expect((await readRow(connectionId)).secretRef).toBe(clean.secretRef);

    // …and a row carrying it, however it were obtained, cannot become a DTO.
    const leaking = { ...clean, secretRef: leakingRef };
    expect(() => toProviderConnection(leaking)).toThrow(ZodError);

    // Assertions 1, 2 and 4 of the sibling suite, over the same walk and the same
    // shapes: they go red on this row, which is why they are not decorative.
    expect(containsDeep(leaking, plaintext)).toBe(true);
    expect(containsDeep({ ...toProviderConnection(clean), secretRef: leakingRef }, plaintext)).toBe(
      true
    );
    expect(
      JSON.stringify({ ...toProviderConnection(clean), secretRef: leakingRef })
    ).toContain(plaintext);
  });

  /**
   * Assertion 5, the audit trail.
   *
   * The row is inserted directly rather than through `writeAuditEvent`, and that
   * is the point: `AuditMetadataValue` closes `metadata` at COMPILE time for the
   * service's own writers, so the only leak left is one written by something the
   * type never saw — a migration, a manual repair, a future writer. This case is
   * what says the runtime assertion still catches that.
   */
  it('catches a credential written into the audit trail', async () => {
    const { plaintext, connectionId, accountId } = await seedConnection();

    expect(containsDeep(await listProviderConnectionAuditEvents(connectionId, 50), plaintext)).toBe(
      false
    );

    await getDb().insert(inferenceProviderConnectionAuditEvents).values({
      connectionId,
      ownerAccountId: accountId,
      eventType: 'used',
      actorKind: 'platform',
      environment: 'production',
      metadata: { upstreamResponse: `provider refused ${plaintext}` },
    });

    const events = await listProviderConnectionAuditEvents(connectionId, 50);
    expect(containsDeep(events, plaintext)).toBe(true);
  });

  /**
   * Why the sibling asserts BOTH forms, and the case that makes the recursive one
   * load-bearing.
   *
   * A half-finished redaction fixes the way OUT and leaves the bytes in place.
   * `JSON.stringify` asks the value how it would like to be serialised and is
   * told `[redacted]`; the walk reads the leaf. Delete the `containsDeep` line
   * from the sibling's assertion and this leak ships green.
   */
  it('catches a leak that `JSON.stringify` alone does not', async () => {
    const { plaintext, connectionId } = await seedConnection();
    const dto = toProviderConnection(await readRow(connectionId));

    const halfRedacted = {
      ...dto,
      validation: {
        ...dto.validation,
        upstreamDetail: { raw: plaintext, toJSON: () => '[redacted]' },
      },
    };

    expect(JSON.stringify(halfRedacted)).not.toContain(plaintext);
    expect(containsDeep(halfRedacted, plaintext)).toBe(true);
  });
});

describe('mutations the contract refuses before any check runs', () => {
  /**
   * The obvious serializer leak — widening the field designed to show PART of a
   * key until it shows all of it — cannot produce a DTO at all. The 12-character
   * cap is not a display preference; it is what makes that mutation unbuildable.
   */
  it('refuses a row whose keyPrefix is the whole credential', async () => {
    const { plaintext, connectionId } = await seedConnection();
    const row = await readRow(connectionId);

    try {
      toProviderConnection({ ...row, keyPrefix: plaintext });
      throw new Error('expected the contract to refuse a credential-length keyPrefix');
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      expect(error.issues.map((issue) => issue.path.join('.'))).toContain('keyPrefix');
    }
  });

  /**
   * The other one: a serializer that attaches the credential under a new name.
   * `.strict()` refuses the parse rather than stripping the field, which is the
   * difference between "this never existed" and "this existed and we removed it
   * on the way out, after the log line".
   */
  it('refuses a DTO that grew a field carrying the credential', async () => {
    const { plaintext, connectionId } = await seedConnection();
    const dto = toProviderConnection(await readRow(connectionId));

    // The unmutated DTO round-trips, so the refusal below is about the added
    // field and not about a DTO the contract never accepted.
    expect(providerConnectionSchema.safeParse(dto).success).toBe(true);
    expect(providerConnectionSchema.safeParse({ ...dto, apiKey: plaintext }).success).toBe(false);
  });
});

describe('the checks are not vacuous', () => {
  /**
   * The positive control and the vacuity floor in one: `containsDeep` says NO to
   * the credential on an untouched connection, YES to a value that is genuinely
   * present and reachable only at depth two, and NO to a string that is nowhere.
   *
   * Without the middle assertion a walk that always returned false would satisfy
   * every leak assertion in the sibling file, and "no leak found" and "this
   * function finds nothing" would look identical.
   */
  it('is green on an untouched connection and still finds what IS there', async () => {
    const { plaintext, connectionId, applicationId } = await seedConnection();
    const row = await readRow(connectionId);
    const dto = toProviderConnection(row);

    expect(containsDeep(dto, plaintext)).toBe(false);
    expect(containsDeep(row, plaintext)).toBe(false);

    // Present only inside `scope`, never at the top level: proof the walk descends.
    expect(dto.scope).toEqual({ kind: 'application', accountId: dto.ownerAccountId, applicationId });
    expect(Object.values(dto).includes(applicationId)).toBe(false);
    expect(containsDeep(dto, applicationId)).toBe(true);

    expect(containsDeep(dto, `absent-${randomUUID()}`)).toBe(false);
  });

  /**
   * Where the walk is BLIND, measured rather than assumed.
   *
   * `ProviderSecretValue` keeps its plaintext in a `#private` field, which
   * `Object.values` does not enumerate and `JSON.stringify` redacts — so an
   * instance of it inside a DTO passes BOTH checks while holding the credential.
   * The sibling's comment used to cite that class as the reason the walk is
   * recursive; it is the one value the walk cannot see. What actually covers it
   * is the contract: `.strict()` gives it no field to sit in.
   */
  it('cannot see a `#private` field, and says so — the contract is what covers it', async () => {
    const { plaintext, connectionId } = await seedConnection();
    const dto = toProviderConnection(await readRow(connectionId));
    const secret = new ProviderSecretValue(plaintext);

    expect(secret.reveal()).toBe(plaintext);
    expect(containsDeep({ secret }, plaintext)).toBe(false);
    expect(JSON.stringify({ secret })).not.toContain(plaintext);

    expect(providerConnectionSchema.safeParse({ ...dto, secret }).success).toBe(false);
  });
});
