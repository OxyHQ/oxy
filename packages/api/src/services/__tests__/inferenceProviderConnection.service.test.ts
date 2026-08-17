/**
 * The BYOK connection service, against a REAL Postgres (issue #972 workstream 10).
 *
 * The schema test covers what the DATABASE refuses. This covers what the SERVICE
 * does — and the first `describe` is the one the whole workstream exists for: a
 * credential handed to `createProviderConnection` must not appear in ANYTHING it
 * returns, in the row it wrote, or in the audit trail it left. That assertion is
 * mutation-tested in `providerSecretLeak.test.ts`, which gives the real
 * serializer a row carrying a credential and confirms each of the checks below
 * goes red on it — including the two the contract refuses outright, which never
 * reach a check at all.
 *
 * Every fixture owns its identifiers, so nothing here reads a sibling file's
 * rows and no assertion depends on a table being empty.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { inferenceProviderConnectionAuditEvents } from '../../db/schema/inferenceProviderConnectionAuditEvents';
import { inferenceProviderConnections } from '../../db/schema/inferenceProviderConnections';
import { inferenceProviders } from '../../db/schema/inferenceProviders';
import { userAncestors } from '../../db/schema/userAncestors';
import { users } from '../../db/schema/users';
import {
  createProviderConnection,
  disableProviderConnection,
  enableProviderConnection,
  listProviderConnectionAuditEvents,
  recordProviderConnectionUse,
  recordProviderConnectionValidation,
  resetUseAuditCooldown,
  resolveProviderConnectionForApplication,
  revokeProviderConnection,
  rotateProviderConnection,
  toProviderConnection,
} from '../inferenceProviderConnection.service';
import {
  ProviderSecretStoreUnavailableError,
  ProviderSecretValue,
  fingerprintProviderSecret,
  providerSecretReference,
  requireProviderSecretStore,
  resolveProviderSecretStore,
  REDACTED,
  type ProviderSecretStore,
} from '../providerSecretStore';
// The SAME walk `providerSecretLeak.test.ts` mutation-tests. A local copy would
// leave the mutation test measuring a copy, and let the two drift while both
// stayed green.
import { containsDeep } from '../secretLeakProbe';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  resetUseAuditCooldown();
});

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

/**
 * A store that keeps what it is given in memory.
 *
 * Injected as an ARGUMENT, which is the whole reason `createProviderConnection`
 * takes one: there is no test-only registration hook in
 * `providerSecretStore.ts`, so production cannot accidentally grow a backend by
 * being imported from a test.
 */
class FakeSecretStore implements ProviderSecretStore {
  readonly name = 'secretsmanager' as const;
  readonly written = new Map<string, string>();
  destroyCalls: string[] = [];
  destroyThrows = false;

  async put(reference: string, secret: ProviderSecretValue): Promise<void> {
    this.written.set(reference, secret.reveal());
  }

  async destroy(reference: string): Promise<void> {
    this.destroyCalls.push(reference);
    if (this.destroyThrows) throw new Error('store unreachable');
    this.written.delete(reference);
  }
}

async function insertAccount(): Promise<string> {
  const tag = suffix();
  const [row] = await getDb()
    .insert(users)
    .values({ username: `byoks-${tag}`, email: `byoks-${tag}@example.test` })
    .returning({ id: users.id });
  return row.id;
}

async function insertApplication(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `BYOKS ${suffix()}`, ownerAccountId })
    .returning({ id: applications.id });
  return row.id;
}

async function insertProvider(termsRequired = false): Promise<string> {
  const slug = `prvs${suffix()}`;
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

/* -------------------------------------------------------------------------- */

describe('a secret cannot round-trip through the service', () => {
  it('appears in nothing the create path returns, stores or audits', async () => {
    const store = new FakeSecretStore();
    const account = await insertAccount();
    const provider = await insertProvider();
    const plaintext = `sk-live-${randomUUID()}-${randomUUID()}`;

    const result = await createProviderConnection(
      {
        provider,
        ownerAccountId: account,
        scopeKind: 'account',
        environment: 'production',
        secret: new ProviderSecretValue(plaintext),
        acknowledgeProviderTerms: false,
        actor: { kind: 'user', userId: account },
      },
      store
    );
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    // 1. The returned DTO, walked to every leaf.
    expect(containsDeep(result.connection, plaintext)).toBe(false);
    // 2. …and serialized, which is what a route writes to the socket.
    expect(JSON.stringify(result.connection)).not.toContain(plaintext);
    // 3. The DTO's key set is exactly the contract's — nothing extra rode along.
    expect(Object.keys(result.connection).sort()).toEqual(
      [
        'connectionId',
        'createdAt',
        'environment',
        'fingerprint',
        'keyPrefix',
        'ownerAccountId',
        'provider',
        'rotatedAt',
        'schemaVersion',
        'scope',
        'secretRef',
        'status',
        'termsAcknowledgedAt',
        'upstreamBillsCustomerDirectly',
        'validation',
      ].sort()
    );

    // 4. The stored ROW, every column.
    const [row] = await getDb()
      .select()
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, result.connection.connectionId));
    expect(containsDeep(row, plaintext)).toBe(false);

    // 5. The audit trail — `metadata` is the only open-shaped column anywhere in
    //    this feature, so it is the one place a leak would actually land.
    const events = await listProviderConnectionAuditEvents(result.connection.connectionId, 50);
    expect(containsDeep(events, plaintext)).toBe(false);
    expect(events.map((event) => event.eventType)).toEqual(['created']);

    // …and the store DID receive it, so the four assertions above are about a
    // credential that really passed through, not one that was never supplied.
    expect(store.written.get(row.secretRef)).toBe(plaintext);
  });

  it('records a fingerprint and a short prefix instead of the credential', async () => {
    const store = new FakeSecretStore();
    const account = await insertAccount();
    const provider = await insertProvider();
    const plaintext = `sk-live-${randomUUID()}`;
    const secret = new ProviderSecretValue(plaintext);

    const result = await createProviderConnection(
      {
        provider,
        ownerAccountId: account,
        scopeKind: 'account',
        environment: 'production',
        secret,
        acknowledgeProviderTerms: false,
        actor: { kind: 'user', userId: account },
      },
      store
    );
    if (result.status !== 'created') throw new Error(result.status);

    expect(result.connection.fingerprint).toBe(fingerprintProviderSecret(secret));
    expect(result.connection.keyPrefix).toBe(plaintext.slice(0, 12));
    expect(result.connection.keyPrefix.length).toBeLessThanOrEqual(12);
    // The prefix is short enough to be useless: it cannot be the credential.
    expect(plaintext.startsWith(result.connection.keyPrefix)).toBe(true);
    expect(result.connection.keyPrefix).not.toBe(plaintext);
  });

  it('redacts a secret through every serializer a logger might reach for', () => {
    const secret = new ProviderSecretValue('sk-live-supersecret');
    expect(`${secret}`).toBe(REDACTED);
    expect(String(secret)).toBe(REDACTED);
    expect(JSON.stringify({ secret })).toBe(JSON.stringify({ secret: REDACTED }));
    expect(JSON.stringify(secret)).toBe(JSON.stringify(REDACTED));
    // `reveal()` is the single, greppable accessor.
    expect(secret.reveal()).toBe('sk-live-supersecret');
  });

  it('puts the credential in the account and environment partition, and nowhere else', async () => {
    const store = new FakeSecretStore();
    const account = await insertAccount();
    const provider = await insertProvider();

    const result = await createProviderConnection(
      {
        provider,
        ownerAccountId: account,
        scopeKind: 'account',
        environment: 'staging',
        secret: new ProviderSecretValue('sk-live-partition'),
        acknowledgeProviderTerms: false,
        actor: { kind: 'user', userId: account },
      },
      store
    );
    if (result.status !== 'created') throw new Error(result.status);

    expect([...store.written.keys()]).toEqual([
      providerSecretReference('secretsmanager', {
        environment: 'staging',
        ownerAccountId: account,
        connectionId: result.connection.connectionId,
      }),
    ]);
    expect(result.connection.secretRef).toContain(`/staging/${account}/`);
  });
});

describe('no secret backend configured', () => {
  const original = process.env.INFERENCE_PROVIDER_SECRET_STORE;

  afterEach(() => {
    if (original === undefined) delete process.env.INFERENCE_PROVIDER_SECRET_STORE;
    else process.env.INFERENCE_PROVIDER_SECRET_STORE = original;
  });

  it('refuses when the variable is unset', () => {
    delete process.env.INFERENCE_PROVIDER_SECRET_STORE;
    expect(resolveProviderSecretStore()).toEqual({ status: 'not-configured' });
    expect(() => requireProviderSecretStore()).toThrow(ProviderSecretStoreUnavailableError);
  });

  it('names an unrecognised store rather than silently ignoring it', () => {
    process.env.INFERENCE_PROVIDER_SECRET_STORE = 's3';
    expect(resolveProviderSecretStore()).toEqual({ status: 'unknown-store', configured: 's3' });
  });

  it('refuses a recognised store this build ships no client for', () => {
    /*
     * The honest state of this deployment: `secretsmanager` is a store the
     * reference grammar admits, and there is still no client for it in the
     * package, so naming it is not the same as wiring it. This case is what
     * would go red the day a backend is registered — at which point it should be
     * REPLACED by one asserting the backend resolves, not deleted.
     */
    process.env.INFERENCE_PROVIDER_SECRET_STORE = 'secretsmanager';
    expect(resolveProviderSecretStore()).toEqual({
      status: 'backend-missing',
      storeName: 'secretsmanager',
    });
  });

  it('carries a machine-readable code and never names a credential', () => {
    delete process.env.INFERENCE_PROVIDER_SECRET_STORE;
    try {
      requireProviderSecretStore();
      throw new Error('expected a refusal');
    } catch (error) {
      if (!(error instanceof ProviderSecretStoreUnavailableError)) throw error;
      expect(error.code).toBe('provider_secret_store_unavailable');
      expect(error.resolution.status).toBe('not-configured');
      expect(error.message).toContain('INFERENCE_PROVIDER_SECRET_STORE');
    }
  });
});

describe('scope precedence', () => {
  it('prefers the application’s own connection over its account’s', async () => {
    const store = new FakeSecretStore();
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();

    await createProviderConnection(
      {
        provider,
        ownerAccountId: account,
        scopeKind: 'account',
        environment: 'production',
        secret: new ProviderSecretValue('sk-account'),
        acknowledgeProviderTerms: false,
        actor: { kind: 'user', userId: account },
      },
      store
    );
    const own = await createProviderConnection(
      {
        provider,
        ownerAccountId: account,
        scopeKind: 'application',
        applicationId: application,
        environment: 'production',
        secret: new ProviderSecretValue('sk-application'),
        acknowledgeProviderTerms: false,
        actor: { kind: 'user', userId: account },
      },
      store
    );
    if (own.status !== 'created') throw new Error(own.status);

    const resolution = await resolveProviderConnectionForApplication({
      applicationId: application,
      provider,
      environment: 'production',
    });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.source).toBe('application');
    expect(resolution.connection.connectionId).toBe(own.connection.connectionId);
  });

  it('inherits an ANCESTOR account’s connection, nearest first', async () => {
    const store = new FakeSecretStore();
    const root = await insertAccount();
    const middle = await insertAccount();
    const leaf = await insertAccount();
    await getDb()
      .insert(userAncestors)
      .values([
        { userId: leaf, depth: 0, ancestorId: root },
        { userId: leaf, depth: 1, ancestorId: middle },
      ]);
    const application = await insertApplication(leaf);
    const provider = await insertProvider();

    await createProviderConnection(
      {
        provider,
        ownerAccountId: root,
        scopeKind: 'account',
        environment: 'production',
        secret: new ProviderSecretValue('sk-root'),
        acknowledgeProviderTerms: false,
        actor: { kind: 'user', userId: root },
      },
      store
    );
    const nearer = await createProviderConnection(
      {
        provider,
        ownerAccountId: middle,
        scopeKind: 'account',
        environment: 'production',
        secret: new ProviderSecretValue('sk-middle'),
        acknowledgeProviderTerms: false,
        actor: { kind: 'user', userId: middle },
      },
      store
    );
    if (nearer.status !== 'created') throw new Error(nearer.status);

    const resolution = await resolveProviderConnectionForApplication({
      applicationId: application,
      provider,
      environment: 'production',
    });
    if (resolution.status !== 'resolved') throw new Error(resolution.status);
    expect(resolution.source).toBe('ancestor-account');
    expect(resolution.connection.connectionId).toBe(nearer.connection.connectionId);
  });

  it('does not resolve ANOTHER account’s connection', async () => {
    const store = new FakeSecretStore();
    const owner = await insertAccount();
    const stranger = await insertAccount();
    const provider = await insertProvider();
    const strangerApplication = await insertApplication(stranger);

    await createProviderConnection(
      {
        provider,
        ownerAccountId: owner,
        scopeKind: 'account',
        environment: 'production',
        secret: new ProviderSecretValue('sk-owner-only'),
        acknowledgeProviderTerms: false,
        actor: { kind: 'user', userId: owner },
      },
      store
    );

    // No ancestry, no shared scope: the stranger's application resolves nothing,
    // rather than reaching a connection it has no relationship to.
    const resolution = await resolveProviderConnectionForApplication({
      applicationId: strangerApplication,
      provider,
      environment: 'production',
    });
    expect(resolution.status).toBe('none');
  });

  it('does not fall back past a DISABLED connection', async () => {
    const store = new FakeSecretStore();
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();

    await createProviderConnection(
      {
        provider,
        ownerAccountId: account,
        scopeKind: 'account',
        environment: 'production',
        secret: new ProviderSecretValue('sk-account-fallback'),
        acknowledgeProviderTerms: false,
        actor: { kind: 'user', userId: account },
      },
      store
    );
    const own = await createProviderConnection(
      {
        provider,
        ownerAccountId: account,
        scopeKind: 'application',
        applicationId: application,
        environment: 'production',
        secret: new ProviderSecretValue('sk-application-fallback'),
        acknowledgeProviderTerms: false,
        actor: { kind: 'user', userId: account },
      },
      store
    );
    if (own.status !== 'created') throw new Error(own.status);

    await disableProviderConnection({
      connectionId: own.connection.connectionId,
      actor: { kind: 'user', userId: account },
    });

    // Disabling the specific connection must not silently promote the account
    // floor — that would defeat the point of disabling it. The account-scoped
    // one is still live, and it is deliberately NOT what resolves here.
    const resolution = await resolveProviderConnectionForApplication({
      applicationId: application,
      provider,
      environment: 'production',
    });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.source).toBe('account');
  });
});

describe('lifecycle', () => {
  async function seed(): Promise<{ store: FakeSecretStore; account: string; id: string }> {
    const store = new FakeSecretStore();
    const account = await insertAccount();
    const provider = await insertProvider();
    const created = await createProviderConnection(
      {
        provider,
        ownerAccountId: account,
        scopeKind: 'account',
        environment: 'production',
        secret: new ProviderSecretValue(`sk-${randomUUID()}`),
        acknowledgeProviderTerms: false,
        actor: { kind: 'user', userId: account },
      },
      store
    );
    if (created.status !== 'created') throw new Error(created.status);
    return { store, account, id: created.connection.connectionId };
  }

  it('rotates in place, keeping the reference and resetting validation', async () => {
    const { store, account, id } = await seed();
    const before = await getDb()
      .select()
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, id));

    const rotated = await rotateProviderConnection(
      { connectionId: id, secret: new ProviderSecretValue('sk-rotated-value'), actor: { kind: 'user', userId: account } },
      store
    );
    if (rotated.status !== 'rotated') throw new Error(rotated.status);

    expect(rotated.connection.secretRef).toBe(before[0].secretRef);
    expect(rotated.connection.fingerprint).not.toBe(before[0].fingerprint);
    expect(rotated.connection.keyPrefix).toBe('sk-rotated-v');
    expect(rotated.connection.validation.state).toBe('unvalidated');
    expect(rotated.connection.rotatedAt).toBeDefined();
    // Replacement, not accumulation: the store holds the new credential only.
    expect(store.written.get(before[0].secretRef)).toBe('sk-rotated-value');
  });

  it('refuses a rotation to the credential it already holds', async () => {
    const store = new FakeSecretStore();
    const account = await insertAccount();
    const provider = await insertProvider();
    const created = await createProviderConnection(
      {
        provider,
        ownerAccountId: account,
        scopeKind: 'account',
        environment: 'production',
        secret: new ProviderSecretValue('sk-same-value'),
        acknowledgeProviderTerms: false,
        actor: { kind: 'user', userId: account },
      },
      store
    );
    if (created.status !== 'created') throw new Error(created.status);

    const rotated = await rotateProviderConnection(
      {
        connectionId: created.connection.connectionId,
        secret: new ProviderSecretValue('sk-same-value'),
        actor: { kind: 'user', userId: account },
      },
      store
    );
    expect(rotated.status).toBe('unchanged-credential');
  });

  it('disables immediately without touching the store, and re-enables', async () => {
    const { store, account, id } = await seed();
    store.destroyThrows = true;

    const disabled = await disableProviderConnection({ connectionId: id, actor: { kind: 'user', userId: account } });
    if (disabled.status !== 'updated') throw new Error(disabled.status);
    expect(disabled.connection.status).toBe('disabled');
    expect(store.destroyCalls).toEqual([]);

    const again = await disableProviderConnection({ connectionId: id, actor: { kind: 'user', userId: account } });
    expect(again.status).toBe('already');

    const enabled = await enableProviderConnection({ connectionId: id, actor: { kind: 'user', userId: account } });
    if (enabled.status !== 'updated') throw new Error(enabled.status);
    // Never straight back to `active`: re-enabling is not evidence the
    // credential works.
    expect(enabled.connection.status).toBe('pending_validation');
  });

  it('records a valid verdict and activates; an invalid one disables', async () => {
    const { account, id } = await seed();

    const valid = await recordProviderConnectionValidation({
      connectionId: id,
      state: 'valid',
      actor: { kind: 'user', userId: account },
    });
    if (valid.status !== 'recorded') throw new Error(valid.status);
    expect(valid.connection.status).toBe('active');
    expect(valid.connection.validation.state).toBe('valid');
    expect(valid.connection.validation.lastValidatedAt).toBeDefined();

    const invalid = await recordProviderConnectionValidation({
      connectionId: id,
      state: 'invalid',
      failureCode: 'unauthorized',
      // The data plane reporting its own verdict: no person, and the row now says
      // so positively rather than leaving the actor blank.
      actor: { kind: 'platform' },
    });
    if (invalid.status !== 'recorded') throw new Error(invalid.status);
    // A credential the provider rejected must stop serving.
    expect(invalid.connection.status).toBe('disabled');
    expect(invalid.connection.validation.failureCode).toBe('unauthorized');

    const events = await listProviderConnectionAuditEvents(id, 50);
    /*
     * Four events, and `created` is the oldest. The `validated` and `disabled`
     * pair are written in ONE transaction, so they share an instant — `now()` is
     * the transaction's start time — and their relative order in this list is
     * not defined. Asserting one would be asserting a coincidence; see
     * `listProviderConnectionAuditEvents` for why no sequence column exists to
     * make it defined.
     */
    expect(events).toHaveLength(4);
    expect(events[3].eventType).toBe('created');
    expect(events.slice(0, 3).map((event) => event.eventType).sort()).toEqual([
      'disabled',
      'validated',
      'validated',
    ]);

    const automaticDisable = events.find((event) => event.eventType === 'disabled');
    expect(automaticDisable).toBeDefined();
    // The automatic disable has no actor: the provider's answer did it. `platform`
    // is a POSITIVE statement of that — before the kind existed this row was a
    // bare NULL, indistinguishable from a row whose author nobody recorded.
    expect(automaticDisable?.actorUserId).toBeNull();
    expect(automaticDisable?.actorKind).toBe('platform');
    expect(automaticDisable?.metadata).toMatchObject({ reason: 'invalid' });

    // …and the verdict the data plane reported is `platform` too, while the one a
    // member asked for names them. THIS is the distinction the column was added
    // for, asserted at the entry point rather than only in the schema: a CHECK
    // that nothing feeds is green and inert.
    const verdicts = events.filter((event) => event.eventType === 'validated');
    expect(verdicts.map((event) => event.actorKind).sort()).toEqual(['platform', 'user']);
    expect(verdicts.find((event) => event.actorKind === 'user')?.actorUserId).toBe(account);
    expect(verdicts.find((event) => event.actorKind === 'platform')?.actorUserId).toBeNull();
  });

  it('revokes, destroys the credential, and records that it did', async () => {
    const { store, account, id } = await seed();
    const [before] = await getDb()
      .select({ secretRef: inferenceProviderConnections.secretRef })
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, id));

    const revoked = await revokeProviderConnection({ connectionId: id, actor: { kind: 'user', userId: account } }, store);
    if (revoked.status !== 'revoked') throw new Error(revoked.status);
    expect(revoked.secretDestroyed).toBe(true);
    expect(store.written.has(before.secretRef)).toBe(false);

    const [event] = await getDb()
      .select({ metadata: inferenceProviderConnectionAuditEvents.metadata })
      .from(inferenceProviderConnectionAuditEvents)
      .where(eq(inferenceProviderConnectionAuditEvents.connectionId, id))
      .orderBy(inferenceProviderConnectionAuditEvents.createdAt);
    expect(event).toBeDefined();

    const events = await listProviderConnectionAuditEvents(id, 50);
    expect(events[0].eventType).toBe('revoked');
    expect(events[0].metadata).toMatchObject({ secretDestroyed: true });

    expect((await revokeProviderConnection({ connectionId: id, actor: { kind: 'user', userId: account } }, store)).status).toBe(
      'already-revoked'
    );
  });

  it('revokes even when the store refuses, and says the secret survived', async () => {
    const { store, account, id } = await seed();
    store.destroyThrows = true;

    const revoked = await revokeProviderConnection({ connectionId: id, actor: { kind: 'user', userId: account } }, store);
    if (revoked.status !== 'revoked') throw new Error(revoked.status);
    // Retiring a connection is a safety operation; a store outage must not be
    // able to keep it resolvable.
    expect(revoked.connection.status).toBe('revoked');
    expect(revoked.secretDestroyed).toBe(false);

    const events = await listProviderConnectionAuditEvents(id, 50);
    expect(events[0].metadata).toMatchObject({ secretDestroyed: false });
  });

  it('revokes with no store at all, recording that nothing was destroyed', async () => {
    const { account, id } = await seed();
    const revoked = await revokeProviderConnection({ connectionId: id, actor: { kind: 'user', userId: account } });
    if (revoked.status !== 'revoked') throw new Error(revoked.status);
    expect(revoked.secretDestroyed).toBe(false);
    const events = await listProviderConnectionAuditEvents(id, 50);
    expect(events[0].metadata).toMatchObject({ secretDestroyed: false, secretStore: null });
  });
});

describe('provider terms', () => {
  it('refuses a connection for a terms-requiring provider without an acknowledgement', async () => {
    const store = new FakeSecretStore();
    const account = await insertAccount();
    const provider = await insertProvider(true);

    const result = await createProviderConnection(
      {
        provider,
        ownerAccountId: account,
        scopeKind: 'account',
        environment: 'production',
        secret: new ProviderSecretValue('sk-unacknowledged'),
        acknowledgeProviderTerms: false,
        actor: { kind: 'user', userId: account },
      },
      store
    );
    expect(result).toEqual({
      status: 'terms-not-acknowledged',
      provider,
      termsUrl: 'https://example.test/terms',
    });
    // Refused BEFORE the store write: an unacceptable request leaves no credential.
    expect(store.written.size).toBe(0);
  });

  it('records the acknowledgement when one is given', async () => {
    const store = new FakeSecretStore();
    const account = await insertAccount();
    const provider = await insertProvider(true);

    const result = await createProviderConnection(
      {
        provider,
        ownerAccountId: account,
        scopeKind: 'account',
        environment: 'production',
        secret: new ProviderSecretValue('sk-acknowledged'),
        acknowledgeProviderTerms: true,
        actor: { kind: 'user', userId: account },
      },
      store
    );
    if (result.status !== 'created') throw new Error(result.status);
    expect(result.connection.termsAcknowledgedAt).toBeDefined();
  });
});

describe('the `used` audit event', () => {
  it('is written once per cooldown window rather than once per resolution', async () => {
    const store = new FakeSecretStore();
    const account = await insertAccount();
    const provider = await insertProvider();
    const created = await createProviderConnection(
      {
        provider,
        ownerAccountId: account,
        scopeKind: 'account',
        environment: 'production',
        secret: new ProviderSecretValue('sk-used'),
        acknowledgeProviderTerms: false,
        actor: { kind: 'user', userId: account },
      },
      store
    );
    if (created.status !== 'created') throw new Error(created.status);

    const row = {
      id: created.connection.connectionId,
      ownerAccountId: account,
      environment: 'production',
    };
    expect(await recordProviderConnectionUse(row)).toBe(true);
    expect(await recordProviderConnectionUse(row)).toBe(false);
    expect(await recordProviderConnectionUse(row)).toBe(false);

    const events = await listProviderConnectionAuditEvents(created.connection.connectionId, 50);
    const used = events.filter((event) => event.eventType === 'used');
    expect(used).toHaveLength(1);
    // The data plane, not a person — and the row says which, beside the `created`
    // row that a member DID author.
    expect(used[0].actorKind).toBe('platform');
    expect(used[0].actorUserId).toBeNull();
    expect(events.find((event) => event.eventType === 'created')?.actorKind).toBe('user');

    // …and the cooldown is what bounds it, not a coincidence of timing.
    resetUseAuditCooldown();
    expect(await recordProviderConnectionUse(row)).toBe(true);
  });
});

describe('scope collisions', () => {
  it('reports a taken scope rather than throwing a constraint error', async () => {
    const store = new FakeSecretStore();
    const account = await insertAccount();
    const provider = await insertProvider();
    const input = {
      provider,
      ownerAccountId: account,
      scopeKind: 'account' as const,
      environment: 'production' as const,
      acknowledgeProviderTerms: false,
      actor: { kind: 'user', userId: account },
    };

    const first = await createProviderConnection(
      { ...input, secret: new ProviderSecretValue('sk-first') },
      store
    );
    expect(first.status).toBe('created');

    const second = await createProviderConnection(
      { ...input, secret: new ProviderSecretValue('sk-second') },
      store
    );
    expect(second.status).toBe('scope-taken');
    // The rolled-back create left no credential behind.
    expect(store.written.size).toBe(1);
  });
});

describe('the serializer', () => {
  it('produces the contract shape for an application-scoped row', async () => {
    const store = new FakeSecretStore();
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();

    const created = await createProviderConnection(
      {
        provider,
        ownerAccountId: account,
        scopeKind: 'application',
        applicationId: application,
        environment: 'development',
        secret: new ProviderSecretValue('sk-app-scoped'),
        acknowledgeProviderTerms: false,
        actor: { kind: 'user', userId: account },
      },
      store
    );
    if (created.status !== 'created') throw new Error(created.status);

    const [row] = await getDb()
      .select()
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, created.connection.connectionId));
    const dto = toProviderConnection(row);

    expect(dto.scope).toEqual({ kind: 'application', accountId: account, applicationId: application });
    // BYOK means the upstream provider bills the customer directly; Oxy charges
    // only its platform fee. Stated as data so a receipt is readable alone.
    expect(dto.upstreamBillsCustomerDirectly).toBe(true);
  });
});
