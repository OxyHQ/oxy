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
   * The one leak the row's own constraints do not stop.
   *
   * `secret_ref` is copied to the DTO verbatim, and both things that guard it —
   * the format regex and the partition CHECK — constrain the SHAPE of the
   * locator, not its contents: a credential spliced in after the store name
   * satisfies `^(vault|kms|ssm|secretsmanager):[A-Za-z0-9/_.:@-]+$` and still ends
   * with `/<environment>/<account>/<id>`. `providerSecretReferenceSchema`'s own
   * comment says "a producer cannot pass a raw key through this field and have it
   * look like a reference"; measured, it can. The database accepts the write, the
   * contract accepts the parse, and the assertion is the only thing that refuses.
   */
  it('catches a credential the serializer copies out of the stored row', async () => {
    const { plaintext, connectionId } = await seedConnection();
    const clean = await readRow(connectionId);

    const colon = clean.secretRef.indexOf(':');
    const leakingRef = `${clean.secretRef.slice(0, colon + 1)}${plaintext}/${clean.secretRef.slice(colon + 1)}`;
    await getDb()
      .update(inferenceProviderConnections)
      .set({ secretRef: leakingRef })
      .where(eq(inferenceProviderConnections.id, connectionId));

    const leaking = await readRow(connectionId);
    // The write really landed — a mutation that never applied is indistinguishable
    // from one the checks survived.
    expect(leaking.secretRef).toBe(leakingRef);

    // Assertion 4 of the sibling suite: the stored ROW, every column.
    expect(containsDeep(leaking, plaintext)).toBe(true);

    const dto = toProviderConnection(leaking);
    // Assertions 1 and 2: the returned DTO, and the DTO as a route writes it.
    expect(containsDeep(dto, plaintext)).toBe(true);
    expect(JSON.stringify(dto)).toContain(plaintext);
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
