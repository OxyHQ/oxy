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
  type ProviderConnectionActorKind,
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
 * WHICH constraint refused the write, from the same wrapped error.
 *
 * The table carries thirteen CHECKs and every one answers with SQLSTATE 23514, so a
 * case that meant to exercise one and actually tripped another reads as a pass.
 */
function pgErrorConstraint(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const name: unknown = Reflect.get(current, 'constraint_name');
    if (typeof name === 'string') return name;
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
      expect(
        providerSecretReferenceSchema.safeParse(
          `${store}:oxy/inference/byok/production/acc_1/pcx_1`
        ).success
      ).toBe(true);
    }
    // …and the converse, so the tuple cannot silently grow past the contract.
    expect(
      providerSecretReferenceSchema.safeParse('s3:oxy/inference/byok/production/acc_1/pcx_1')
        .success
    ).toBe(false);
  });
});

/**
 * The reference grammar, run through the CONTRACT and the CHECK as one table.
 *
 * `PROVIDER_SECRET_REFERENCE_PATTERN` is a restatement of
 * `providerSecretReferenceSchema` in a different regex dialect — deliberately, for
 * the reason `inferenceSlug.ts` gives — and a restatement is a fork the moment
 * nothing compares the two. This is what compares them: one table, both verdicts,
 * asserted equal case by case.
 *
 * Every case keeps the partition suffix `/<environment>/<account>/<id>` intact, so
 * a refusal can only come from the format CHECK. That is asserted by NAME: a case
 * that fell foul of the partition rule instead would prove nothing about the
 * grammar, and the two are indistinguishable from the SQLSTATE alone.
 */
describe('the reference grammar is the same one on the wire and in the column', () => {
  /**
   * The value being smuggled: the length and shape of a real credential, composed
   * rather than written out so it stays under `check-secret-scan.mjs`'s 40-character
   * `sk-` floor — the floor is what tells an issued key from a fixture.
   */
  const CREDENTIAL = `sk-ant-api03-${'9f2Ab_cD3e'.repeat(6)}AA`;

  const CASES: ReadonlyArray<{
    readonly name: string;
    readonly accepted: boolean;
    readonly build: (account: string, id: string) => string;
  }> = [
    ...PROVIDER_SECRET_STORE_NAMES.map((store) => ({
      name: `the canonical reference in ${store}`,
      accepted: true,
      build: (account: string, id: string) =>
        `${store}:oxy/inference/byok/production/${account}/${id}`,
    })),
    {
      // THE CASE THE GRAMMAR WAS TIGHTENED FOR. Before migration 0054 this was
      // written, stored and read back with the credential in it.
      name: 'a credential spliced in after the store name',
      accepted: false,
      build: (account, id) =>
        `vault:${CREDENTIAL}/oxy/inference/byok/production/${account}/${id}`,
    },
    {
      name: 'a store nothing in this system can resolve',
      accepted: false,
      build: (account, id) => `s3:oxy/inference/byok/production/${account}/${id}`,
    },
    {
      name: 'a namespace no store-side policy is scoped to',
      accepted: false,
      build: (account, id) => `vault:oxy/byok/production/${account}/${id}`,
    },
    {
      name: 'whitespace inside the namespace',
      accepted: false,
      build: (account, id) => `vault:oxy/inference byok/production/${account}/${id}`,
    },
    {
      name: 'an extra segment before the partition',
      accepted: false,
      build: (account, id) => `vault:oxy/inference/byok/extra/production/${account}/${id}`,
    },
  ];

  for (const { name, accepted, build } of CASES) {
    it(`${accepted ? 'accepts' : 'refuses'} ${name}, on the wire and in the column`, async () => {
      const account = await insertAccount();
      const provider = await insertProvider();
      const values = connectionValues(provider, account, { environment: 'production' });
      const secretRef = build(account, values.id);

      // Every case is a well-formed member of its own partition, so nothing here
      // is refused for naming another account's or another environment's secret.
      expect(secretRef.endsWith(`/production/${account}/${values.id}`)).toBe(true);
      expect(providerSecretReferenceSchema.safeParse(secretRef).success).toBe(accepted);

      const write = getDb()
        .insert(inferenceProviderConnections)
        .values({ ...values, secretRef })
        .returning({ secretRef: inferenceProviderConnections.secretRef });

      if (accepted) {
        const [row] = await write;
        expect(row.secretRef).toBe(secretRef);
        return;
      }

      try {
        await write;
      } catch (error) {
        expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
        expect(pgErrorConstraint(error)).toBe(
          'inference_provider_connections_secret_ref_format'
        );
        return;
      }
      throw new Error(`expected the format CHECK to refuse ${secretRef}`);
    });
  }
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

describe('the audit trail says what KIND of principal acted', () => {
  /** A connection to hang audit rows off, and the account that owns it. */
  async function trailFixture(): Promise<{ account: string; connectionId: string; environment: string }> {
    const account = await insertAccount();
    const provider = await insertProvider();
    const connection = connectionValues(provider, account);
    await getDb().insert(inferenceProviderConnections).values(connection);
    return { account, connectionId: connection.id, environment: connection.environment };
  }

  it('accepts each of the four legal states', async () => {
    const { account, connectionId, environment } = await trailFixture();

    // ('user', <id>) — a named person, through a session bearer.
    await getDb().insert(inferenceProviderConnectionAuditEvents).values({
      connectionId,
      ownerAccountId: account,
      eventType: 'created',
      actorKind: 'user',
      actorUserId: account,
      environment,
    });
    // ('service', null) — a customer's service credential. The account it acts
    // for is this row's `owner_account_id`, so there is no second id.
    await getDb().insert(inferenceProviderConnectionAuditEvents).values({
      connectionId,
      ownerAccountId: account,
      eventType: 'rotated',
      actorKind: 'service',
      environment,
    });
    // ('platform', null) — Oxy's own machinery, no principal at all.
    await getDb().insert(inferenceProviderConnectionAuditEvents).values({
      connectionId,
      ownerAccountId: account,
      eventType: 'used',
      actorKind: 'platform',
      environment,
    });
    // (null, <id>) — the legacy row shape. Accepted DELIBERATELY: rows written
    // before `0049` name someone whose kind nobody recorded, and a migration
    // that refused them could not be applied to a database that has them.
    await getDb().insert(inferenceProviderConnectionAuditEvents).values({
      connectionId,
      ownerAccountId: account,
      eventType: 'disabled',
      actorUserId: account,
      environment,
    });

    const rows = await getDb()
      .select({
        eventType: inferenceProviderConnectionAuditEvents.eventType,
        actorKind: inferenceProviderConnectionAuditEvents.actorKind,
        actorUserId: inferenceProviderConnectionAuditEvents.actorUserId,
      })
      .from(inferenceProviderConnectionAuditEvents)
      .where(eq(inferenceProviderConnectionAuditEvents.connectionId, connectionId));
    expect(rows).toHaveLength(4);
    // The point of the column, stated as an assertion: two rows that used to be
    // indistinguishable now differ.
    const created = rows.find((row) => row.eventType === 'created');
    const rotated = rows.find((row) => row.eventType === 'rotated');
    expect(created?.actorKind).toBe('user');
    expect(created?.actorUserId).toBe(account);
    expect(rotated?.actorKind).toBe('service');
    expect(rotated?.actorUserId).toBeNull();
  });

  it('refuses a `user` row that does not name the person', async () => {
    const { account, connectionId, environment } = await trailFixture();

    // "A person did this and we will not say who" is the state the pair exists
    // to make unwritable.
    await expectPgError(
      getDb().insert(inferenceProviderConnectionAuditEvents).values({
        connectionId,
        ownerAccountId: account,
        eventType: 'created',
        actorKind: 'user',
        environment,
      }),
      CHECK_VIOLATION
    );
  });

  it('refuses a `service` or `platform` row that names a person', async () => {
    const { account, connectionId, environment } = await trailFixture();

    for (const actorKind of ['service', 'platform'] as const) {
      // "Nobody was behind this, and here is their id" — the false attribution.
      await expectPgError(
        getDb().insert(inferenceProviderConnectionAuditEvents).values({
          connectionId,
          ownerAccountId: account,
          eventType: 'created',
          actorKind,
          actorUserId: account,
          environment,
        }),
        CHECK_VIOLATION
      );
    }
  });

  it('refuses a kind outside the vocabulary, in both id shapes', async () => {
    const { account, connectionId, environment } = await trailFixture();

    /*
     * There is no separate containment CHECK: each branch names its kind as a
     * literal, so an unknown value satisfies none of them. Driven with an id and
     * without one, because a single-shape probe would pass against a constraint
     * that only happened to reject the other shape.
     */
    for (const actorUserId of [account, null]) {
      await expectPgError(
        getDb()
          .insert(inferenceProviderConnectionAuditEvents)
          .values({
            connectionId,
            ownerAccountId: account,
            eventType: 'created',
            // Not a member of PROVIDER_CONNECTION_ACTOR_KINDS. The column is
            // typed to that tuple, so reaching the database at all needs the cast
            // this row does: the point is what POSTGRES does with it.
            actorKind: 'machine' as ProviderConnectionActorKind,
            actorUserId,
            environment,
          }),
        CHECK_VIOLATION
      );
    }
  });

  it('does not change what happens when the named person is deleted', async () => {
    /*
     * `actor_user_id` is `ON DELETE SET NULL`, so deleting the person a row names
     * makes the database UPDATE that row — and a `('user', <id>)` row would become
     * `('user', null)`, which the actor CHECK refuses. That reads like a new way
     * for `DELETE FROM users` to fail, so it is measured rather than assumed, with
     * a legacy-shaped row as the control.
     *
     * Both are refused, identically and for a reason that predates this column:
     * the table is append-only by trigger (0042), which raises the same
     * `check_violation` on ANY update, including one a foreign key performs. So the
     * actor CHECK is never reached on this path and changes nothing about it. The
     * pre-existing consequence — that a `SET NULL` reference into an append-only
     * table cannot actually set null — belongs to 0041/0042 and is deliberately
     * not touched here.
     */
    const owner = await insertAccount();
    const provider = await insertProvider();
    const connection = connectionValues(provider, owner);
    await getDb().insert(inferenceProviderConnections).values(connection);

    // A member, distinct from the owner: the connection's own reference to its
    // owner is RESTRICT, so deleting the owner would be refused before any of
    // this and would prove nothing about the actor column.
    const legacyActor = await insertAccount();
    const namedActor = await insertAccount();

    await getDb().insert(inferenceProviderConnectionAuditEvents).values({
      connectionId: connection.id,
      ownerAccountId: owner,
      eventType: 'disabled',
      actorUserId: legacyActor,
      environment: connection.environment,
    });
    await getDb().insert(inferenceProviderConnectionAuditEvents).values({
      connectionId: connection.id,
      ownerAccountId: owner,
      eventType: 'created',
      actorKind: 'user',
      actorUserId: namedActor,
      environment: connection.environment,
    });

    // CONTROL first: the legacy row carries no `actor_kind`, so the actor CHECK
    // cannot be what refuses this one.
    await expectPgError(
      getDb().delete(users).where(eq(users.id, legacyActor)),
      CHECK_VIOLATION
    );
    // …and the row this column added behaves the same way, not worse.
    await expectPgError(
      getDb().delete(users).where(eq(users.id, namedActor)),
      CHECK_VIOLATION
    );
  });

  it('names its actor constraint, so dropping it fails here', async () => {
    const rows = await getDb().execute(sql`
      select conname
      from pg_constraint
      where conrelid = ${PROVIDER_CONNECTION_AUDIT_TABLE}::regclass and contype = 'c'
    `);
    expect(rows.map((row) => row.conname)).toContain(
      'inference_provider_connection_audit_events_actor_check'
    );
  });
});
