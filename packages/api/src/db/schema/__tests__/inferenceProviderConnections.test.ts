/**
 * The BYOK connection schema, against a REAL Postgres (issue #972 workstream 10).
 *
 * One `describe` per claim the schema files make that a comment alone cannot
 * keep true — and the first of them is the one this whole workstream exists for:
 * that a row cannot name another account's or another environment's secret, and
 * that no shape in this table can hold a credential.
 *
 * Every row carries a per-test random identifier, so no assertion depends on a
 * table being empty and a sibling file seeding rows cannot change an answer.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import {
  providerConnectionScopeSchema,
  providerConnectionStatusSchema,
  providerConnectionValidationSchema,
  providerSecretReferenceSchema,
} from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { applications } from '../applications';
import {
  inferenceProviderConnectionAuditEvents,
  PROVIDER_CONNECTION_AUDIT_EVENT_TYPES,
} from '../inferenceProviderConnectionAuditEvents';
import {
  PROVIDER_CONNECTION_AUDIT_TABLE,
  PROVIDER_CONNECTION_AUDIT_TRIGGER,
} from '../inferenceProviderConnectionImmutability';
import {
  inferenceProviderConnections,
  PROVIDER_CONNECTION_ENVIRONMENTS,
  PROVIDER_CONNECTION_SCOPE_KINDS,
  PROVIDER_CONNECTION_STATUSES,
  PROVIDER_CONNECTION_VALIDATION_FAILURE_CODES,
  PROVIDER_CONNECTION_VALIDATION_STATES,
  PROVIDER_SECRET_STORE_NAMES,
} from '../inferenceProviderConnections';
import { inferenceProviders } from '../inferenceProviders';
import { users } from '../users';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `check_violation` — also what the immutability trigger raises. */
const CHECK_VIOLATION = '23514';
/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

/**
 * The SQLSTATE a driver error carries. Drizzle wraps a driver failure in its own
 * error, so the code lives on the `cause` — walking the chain is what stops every
 * assertion below from degrading into "some error happened".
 */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Assert a write is refused with a SPECIFIC SQLSTATE.
 *
 * Not `rejects.toThrow()`: every one of these cases has a shape that would also
 * fail for an unrelated reason (a missing fixture, a typo in a column), and a
 * bare "it threw" would report that as the constraint working. The `succeeded`
 * throw is the other half — a check that cannot fail is not a check.
 */
async function expectPgError(work: Promise<unknown>, code: string): Promise<void> {
  try {
    await work;
  } catch (error) {
    expect(pgErrorCode(error)).toBe(code);
    return;
  }
  throw new Error(`expected the write to be refused with SQLSTATE ${code}, but it succeeded`);
}

async function insertAccount(): Promise<string> {
  const tag = suffix();
  const [row] = await getDb()
    .insert(users)
    .values({ username: `byok-${tag}`, email: `byok-${tag}@example.test` })
    .returning({ id: users.id });
  return row.id;
}

async function insertApplication(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `BYOK ${suffix()}`, ownerAccountId })
    .returning({ id: applications.id });
  return row.id;
}

async function insertProvider(termsRequired = false): Promise<string> {
  const slug = `prv${suffix()}`;
  await getDb()
    .insert(inferenceProviders)
    .values({
      slug,
      displayName: 'Fixture Provider',
      kind: 'customer_byok',
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
      byokTermsAcknowledgementRequired: termsRequired,
      byokTermsUrl: termsRequired ? 'https://example.test/terms' : null,
    });
  return slug;
}

/** A locator inside the partition the CHECK requires — the only writable shape. */
function reference(input: {
  environment: string;
  ownerAccountId: string;
  connectionId: string;
  store?: string;
}): string {
  const store = input.store ?? 'secretsmanager';
  return `${store}:oxy/inference/byok/${input.environment}/${input.ownerAccountId}/${input.connectionId}`;
}

const FINGERPRINT = 'a'.repeat(64);

interface ConnectionOverrides {
  readonly scopeKind?: (typeof PROVIDER_CONNECTION_SCOPE_KINDS)[number];
  readonly applicationId?: string | null;
  readonly environment?: (typeof PROVIDER_CONNECTION_ENVIRONMENTS)[number];
  readonly status?: (typeof PROVIDER_CONNECTION_STATUSES)[number];
  readonly secretRef?: string;
  readonly keyPrefix?: string;
  readonly fingerprint?: string;
  readonly validationState?: (typeof PROVIDER_CONNECTION_VALIDATION_STATES)[number];
  readonly validationFailureCode?: (typeof PROVIDER_CONNECTION_VALIDATION_FAILURE_CODES)[number];
  readonly termsAcknowledgedAt?: Date | null;
  readonly providerTermsAcknowledgementRequired?: boolean;
}

function connectionValues(
  provider: string,
  ownerAccountId: string,
  overrides: ConnectionOverrides = {}
) {
  const id = uuidv7();
  const environment = overrides.environment ?? 'production';
  return {
    id,
    provider,
    ownerAccountId,
    scopeKind: overrides.scopeKind ?? ('account' as const),
    applicationId: overrides.applicationId ?? null,
    environment,
    status: overrides.status ?? ('pending_validation' as const),
    secretRef:
      overrides.secretRef ?? reference({ environment, ownerAccountId, connectionId: id }),
    keyPrefix: overrides.keyPrefix ?? 'sk-live-1234',
    fingerprint: overrides.fingerprint ?? FINGERPRINT,
    validationState: overrides.validationState ?? ('unvalidated' as const),
    validationFailureCode: overrides.validationFailureCode ?? null,
    termsAcknowledgedAt: overrides.termsAcknowledgedAt ?? null,
    providerTermsAcknowledgementRequired: overrides.providerTermsAcknowledgementRequired ?? false,
  };
}

/* -------------------------------------------------------------------------- */

describe('the closed vocabularies match the contract', () => {
  /*
   * The schema declares its own tuples rather than importing the contract's
   * enums, exactly as `inferenceRoutingPolicyVersions.ts` does, so that the DDL
   * is readable without resolving a zod schema. These four assertions are what
   * makes that a copy rather than a fork: widening either side alone goes red.
   */
  it('scope kinds match `providerConnectionScopeSchema`', () => {
    const contractKinds = providerConnectionScopeSchema.options.map(
      (option) => option.shape.kind.value
    );
    expect([...PROVIDER_CONNECTION_SCOPE_KINDS]).toEqual(contractKinds);
  });

  it('statuses match `providerConnectionStatusSchema`', () => {
    expect([...PROVIDER_CONNECTION_STATUSES]).toEqual(providerConnectionStatusSchema.options);
  });

  it('validation states and failure codes match `providerConnectionValidationSchema`', () => {
    expect([...PROVIDER_CONNECTION_VALIDATION_STATES]).toEqual(
      providerConnectionValidationSchema.shape.state.options
    );
    expect([...PROVIDER_CONNECTION_VALIDATION_FAILURE_CODES]).toEqual(
      providerConnectionValidationSchema.shape.failureCode.unwrap().options
    );
  });

  it('every store name the CHECK admits is one the contract admits', () => {
    for (const store of PROVIDER_SECRET_STORE_NAMES) {
      expect(providerSecretReferenceSchema.safeParse(`${store}:oxy/x`).success).toBe(true);
    }
    // …and the converse, so the tuple cannot silently grow past the contract.
    expect(providerSecretReferenceSchema.safeParse('s3:oxy/x').success).toBe(false);
  });
});

describe('a secret cannot be stored in this table', () => {
  it('refuses a `secret_ref` that is not a `<store>:<locator>` pointer', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();
    const values = connectionValues(provider, account);

    await expectPgError(
      getDb()
        .insert(inferenceProviderConnections)
        // A pasted credential does not look like a locator, and the grammar is
        // what makes that structural rather than a naming convention.
        .values({ ...values, secretRef: 'sk-live-thisisarealkeynotareference' }),
      CHECK_VIOLATION
    );
  });

  it('refuses a `secret_ref` carrying whitespace', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();
    const values = connectionValues(provider, account);

    await expectPgError(
      getDb()
        .insert(inferenceProviderConnections)
        .values({ ...values, secretRef: `secretsmanager:oxy/inference byok/${account}` }),
      CHECK_VIOLATION
    );
  });

  it('caps `key_prefix` at 12 characters, so it cannot be widened into a key', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();
    const values = connectionValues(provider, account);

    await expectPgError(
      getDb()
        .insert(inferenceProviderConnections)
        .values({ ...values, keyPrefix: 'sk-live-0123456789abcdef' }),
      CHECK_VIOLATION
    );
  });

  it('requires `fingerprint` to be 64 lowercase hex characters', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();
    const values = connectionValues(provider, account);

    await expectPgError(
      getDb()
        .insert(inferenceProviderConnections)
        .values({ ...values, fingerprint: 'sk-live-notadigest' }),
      CHECK_VIOLATION
    );
  });
});

describe('the secret reference is pinned to its own account and environment', () => {
  it('accepts a reference inside the row’s own partition', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();
    const values = connectionValues(provider, account);

    const [row] = await getDb()
      .insert(inferenceProviderConnections)
      .values(values)
      .returning({ secretRef: inferenceProviderConnections.secretRef });
    expect(row.secretRef).toBe(values.secretRef);
  });

  it('refuses a reference naming ANOTHER account', async () => {
    const account = await insertAccount();
    const otherAccount = await insertAccount();
    const provider = await insertProvider();
    const values = connectionValues(provider, account);

    await expectPgError(
      getDb()
        .insert(inferenceProviderConnections)
        .values({
          ...values,
          secretRef: reference({
            environment: values.environment,
            ownerAccountId: otherAccount,
            connectionId: values.id,
          }),
        }),
      CHECK_VIOLATION
    );
  });

  it('refuses a reference naming ANOTHER environment', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();
    const values = connectionValues(provider, account, { environment: 'production' });

    await expectPgError(
      getDb()
        .insert(inferenceProviderConnections)
        .values({
          ...values,
          secretRef: reference({
            environment: 'development',
            ownerAccountId: account,
            connectionId: values.id,
          }),
        }),
      CHECK_VIOLATION
    );
  });

  it('refuses a reference naming another CONNECTION', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();
    const values = connectionValues(provider, account);

    await expectPgError(
      getDb()
        .insert(inferenceProviderConnections)
        .values({
          ...values,
          secretRef: reference({
            environment: values.environment,
            ownerAccountId: account,
            connectionId: uuidv7(),
          }),
        }),
      CHECK_VIOLATION
    );
  });

  it('lets no two connections point at one stored secret', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();
    const first = connectionValues(provider, account);
    await getDb().insert(inferenceProviderConnections).values(first);

    /*
     * MEASURED, and it corrects the obvious reading of this table: the
     * uniqueness of `secret_ref` is a CONSEQUENCE of the partition rule, not a
     * second mechanism beside it. The partition suffix ends with the row's own
     * id, so a second row cannot carry the first's reference AND satisfy the
     * partition — Postgres reports the CHECK, and
     * `inference_provider_connections_secret_ref_key` can never be the
     * constraint that fires. The case below asserts the true refusal; the one
     * after it asserts the redundant constraint still EXISTS, since it is the
     * index a lookup by reference reads and the guard that would survive the
     * partition rule being relaxed.
     */
    await expectPgError(
      getDb()
        .insert(inferenceProviderConnections)
        .values(
          connectionValues(provider, account, {
            environment: 'staging',
            secretRef: first.secretRef,
          })
        ),
      CHECK_VIOLATION
    );
  });

  it('still carries the unique constraint on `secret_ref`', async () => {
    const rows = await getDb().execute(sql`
      select conname
      from pg_constraint
      where conrelid = 'inference_provider_connections'::regclass and contype = 'u'
    `);
    expect(rows.map((row) => row.conname)).toContain(
      'inference_provider_connections_secret_ref_key'
    );
  });
});

describe('scope', () => {
  it('requires an application-scoped connection to name an application', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();

    await expectPgError(
      getDb()
        .insert(inferenceProviderConnections)
        .values(connectionValues(provider, account, { scopeKind: 'application' })),
      CHECK_VIOLATION
    );
  });

  it('refuses an account-scoped connection that names one', async () => {
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();

    await expectPgError(
      getDb()
        .insert(inferenceProviderConnections)
        .values(connectionValues(provider, account, { applicationId: application })),
      CHECK_VIOLATION
    );
  });

  it('allows one live connection per scope, provider and environment and no more', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();

    await getDb().insert(inferenceProviderConnections).values(connectionValues(provider, account));

    // The NULL `application_id` on both rows is exactly the case a default
    // `NULLS DISTINCT` unique index would let through.
    await expectPgError(
      getDb().insert(inferenceProviderConnections).values(connectionValues(provider, account)),
      UNIQUE_VIOLATION
    );

    // …but a different environment is a different key.
    await getDb()
      .insert(inferenceProviderConnections)
      .values(connectionValues(provider, account, { environment: 'staging' }));

    // …and a `project`-scoped connection is a different key from an `account` one.
    await getDb()
      .insert(inferenceProviderConnections)
      .values(connectionValues(provider, account, { scopeKind: 'project' }));
  });

  it('lets a revoked connection be replaced', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();
    const first = connectionValues(provider, account);
    await getDb().insert(inferenceProviderConnections).values(first);
    await getDb()
      .update(inferenceProviderConnections)
      .set({ status: 'revoked' })
      .where(eq(inferenceProviderConnections.id, first.id));

    // A partial index on the live statuses: without the predicate this would
    // collide with the revoked row forever.
    await getDb().insert(inferenceProviderConnections).values(connectionValues(provider, account));
  });
});

describe('lifecycle coherence', () => {
  it('refuses an `invalid` credential with no failure code', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();

    await expectPgError(
      getDb()
        .insert(inferenceProviderConnections)
        .values(connectionValues(provider, account, { validationState: 'invalid' })),
      CHECK_VIOLATION
    );
  });

  it('refuses an `active` connection whose credential failed validation', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();

    await expectPgError(
      getDb()
        .insert(inferenceProviderConnections)
        .values(
          connectionValues(provider, account, {
            status: 'active',
            validationState: 'invalid',
            validationFailureCode: 'unauthorized',
          })
        ),
      CHECK_VIOLATION
    );
  });
});

describe('provider terms', () => {
  it('refuses an un-acknowledged connection for a provider that requires it', async () => {
    const account = await insertAccount();
    const provider = await insertProvider(true);

    await expectPgError(
      getDb()
        .insert(inferenceProviderConnections)
        .values(
          connectionValues(provider, account, {
            providerTermsAcknowledgementRequired: true,
            termsAcknowledgedAt: null,
          })
        ),
      CHECK_VIOLATION
    );
  });

  it('refuses a row that disagrees with the catalogue about whether terms are required', async () => {
    const account = await insertAccount();
    const provider = await insertProvider(true);

    // The composite foreign key: claiming the provider needs no acknowledgement
    // is not a claim a row gets to make.
    await expectPgError(
      getDb()
        .insert(inferenceProviderConnections)
        .values(
          connectionValues(provider, account, { providerTermsAcknowledgementRequired: false })
        ),
      FOREIGN_KEY_VIOLATION
    );
  });

  it('accepts an acknowledged connection for a provider that requires it', async () => {
    const account = await insertAccount();
    const provider = await insertProvider(true);

    const [row] = await getDb()
      .insert(inferenceProviderConnections)
      .values(
        connectionValues(provider, account, {
          providerTermsAcknowledgementRequired: true,
          termsAcknowledgedAt: new Date(),
        })
      )
      .returning({ termsAcknowledgedAt: inferenceProviderConnections.termsAcknowledgedAt });
    expect(row.termsAcknowledgedAt).toBeInstanceOf(Date);
  });

  it('refuses turning the requirement on while un-acknowledged connections exist', async () => {
    const account = await insertAccount();
    const provider = await insertProvider(false);
    await getDb().insert(inferenceProviderConnections).values(connectionValues(provider, account));

    // The loud signal the schema header promises: flipping the flag silently
    // would make an existing connection retroactively non-compliant.
    await expectPgError(
      getDb()
        .update(inferenceProviders)
        .set({ byokTermsAcknowledgementRequired: true, byokTermsUrl: 'https://example.test/t' })
        .where(eq(inferenceProviders.slug, provider)),
      FOREIGN_KEY_VIOLATION
    );
  });
});

describe('the audit trail is append-only', () => {
  it('has its immutability trigger installed', async () => {
    const rows = await getDb().execute(sql`
      select t.tgname
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relname = ${PROVIDER_CONNECTION_AUDIT_TABLE}
    `);
    expect(rows.map((row) => row.tgname)).toContain(PROVIDER_CONNECTION_AUDIT_TRIGGER);
  });

  it('refuses an UPDATE to an audit entry', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();
    const connection = connectionValues(provider, account);
    await getDb().insert(inferenceProviderConnections).values(connection);

    const [event] = await getDb()
      .insert(inferenceProviderConnectionAuditEvents)
      .values({
        connectionId: connection.id,
        ownerAccountId: account,
        eventType: 'created',
        environment: connection.environment,
      })
      .returning({ id: inferenceProviderConnectionAuditEvents.id });

    await expectPgError(
      getDb()
        .update(inferenceProviderConnectionAuditEvents)
        .set({ eventType: 'revoked' })
        .where(eq(inferenceProviderConnectionAuditEvents.id, event.id)),
      CHECK_VIOLATION
    );
  });

  it('permits a DELETE, because the retention sweep depends on it', async () => {
    /*
     * This is an ASSERTION, not an omission. `db/expiry.ts` sweeps this table at
     * two years and `used` events accrue for the life of every connection, so a
     * DELETE guard would fail that sweep on every run. If someone later widens
     * the trigger to `BEFORE UPDATE OR DELETE`, this case is what says so —
     * before the sweep starts failing in production instead.
     */
    const account = await insertAccount();
    const provider = await insertProvider();
    const connection = connectionValues(provider, account);
    await getDb().insert(inferenceProviderConnections).values(connection);

    const [event] = await getDb()
      .insert(inferenceProviderConnectionAuditEvents)
      .values({
        connectionId: connection.id,
        ownerAccountId: account,
        eventType: 'used',
        environment: connection.environment,
      })
      .returning({ id: inferenceProviderConnectionAuditEvents.id });

    await getDb()
      .delete(inferenceProviderConnectionAuditEvents)
      .where(eq(inferenceProviderConnectionAuditEvents.id, event.id));
  });

  it('refuses an actor on a `used` event', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();
    const connection = connectionValues(provider, account);
    await getDb().insert(inferenceProviderConnections).values(connection);

    await expectPgError(
      getDb()
        .insert(inferenceProviderConnectionAuditEvents)
        .values({
          connectionId: connection.id,
          ownerAccountId: account,
          eventType: 'used',
          // "The data plane resolved this reference" is not something a member
          // did, and an audit table must not be able to say it was.
          actorUserId: account,
          environment: connection.environment,
        }),
      CHECK_VIOLATION
    );
  });

  it('accepts every event type in the vocabulary', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();
    const connection = connectionValues(provider, account);
    await getDb().insert(inferenceProviderConnections).values(connection);

    for (const eventType of PROVIDER_CONNECTION_AUDIT_EVENT_TYPES) {
      await getDb()
        .insert(inferenceProviderConnectionAuditEvents)
        .values({
          connectionId: connection.id,
          ownerAccountId: account,
          eventType,
          actorUserId: eventType === 'used' ? null : account,
          environment: connection.environment,
        });
    }

    const rows = await getDb()
      .select({ eventType: inferenceProviderConnectionAuditEvents.eventType })
      .from(inferenceProviderConnectionAuditEvents)
      .where(eq(inferenceProviderConnectionAuditEvents.connectionId, connection.id));
    expect(rows).toHaveLength(PROVIDER_CONNECTION_AUDIT_EVENT_TYPES.length);
  });

  it('refuses deleting a connection that has a trail', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();
    const connection = connectionValues(provider, account);
    await getDb().insert(inferenceProviderConnections).values(connection);
    await getDb()
      .insert(inferenceProviderConnectionAuditEvents)
      .values({
        connectionId: connection.id,
        ownerAccountId: account,
        eventType: 'created',
        actorUserId: account,
        environment: connection.environment,
      });

    // `RESTRICT`, so "delete the connection" is not a way to erase its trail. A
    // connection is revoked, never deleted.
    await expectPgError(
      getDb()
        .delete(inferenceProviderConnections)
        .where(eq(inferenceProviderConnections.id, connection.id)),
      FOREIGN_KEY_VIOLATION
    );
  });
});
