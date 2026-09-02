import { randomUUID } from 'node:crypto';
import type { KaanaCredentialOutcome, KaanaCredentialOutcomeRequest } from '@oxyhq/contracts';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { inferenceProviderConnections } from '../../db/schema/inferenceProviderConnections';
import { inferenceProviderCredentialOperations } from '../../db/schema/inferenceProviderCredentialOperations';
import { inferenceProviders } from '../../db/schema/inferenceProviders';
import { users } from '../../db/schema/users';
import {
  createProviderConnection,
  disableProviderConnection,
  reconcileProviderConnection,
  recordProviderConnectionValidation,
  resolveProviderConnectionForApplication,
  revokeProviderConnection,
  rotateProviderConnection,
} from '../inferenceProviderConnection.service';
import {
  KaanaCredentialConflictError,
  KaanaCredentialOutcomeUnavailableError,
  ProviderCredentialValue,
  type KaanaCredentialControl,
  type KaanaCredentialCreateOperation,
  type KaanaCredentialRevokeOperation,
  type KaanaCredentialRotateOperation,
} from '../kaanaCredentialControl';

beforeAll(connectPostgres);
afterAll(closePostgres);

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

type Action = 'create' | 'rotate' | 'revoke';

class FakeKaanaControl implements KaanaCredentialControl {
  readonly mutationCalls: Array<{ action: Action; input: object }> = [];
  readonly outcomeCalls: KaanaCredentialOutcomeRequest[] = [];
  readonly outcomes = new Map<
    string,
    { request: KaanaCredentialOutcomeRequest; outcome: KaanaCredentialOutcome }
  >();
  failAction?: Action;
  loseResponseAction?: Action;
  wrongAcknowledgement?: Action;
  conflictAction?: Action;
  outcomeUnavailable = false;
  beforeMutation?: (action: Action, input: object) => Promise<void>;
  readonly handle = `kcred_${randomUUID()
    .replace(/-/g, '')
    .replace(/[0189]/g, 'a')
    .slice(0, 26)}`;

  async create(input: KaanaCredentialCreateOperation): Promise<KaanaCredentialOutcome> {
    this.mutationCalls.push({ action: 'create', input });
    await this.beforeMutation?.('create', input);
    this.maybeConflictOrFail('create');
    const request: KaanaCredentialOutcomeRequest = {
      schemaVersion: 1,
      operationId: input.operationId,
      action: 'create',
      provider: input.provider,
      ownerAccountId: input.ownerAccountId,
      connectionId: input.connectionId,
      environment: input.environment,
      secretSha256: input.secretSha256,
    };
    const outcome: KaanaCredentialOutcome = {
      schemaVersion: 1,
      operationId: input.operationId,
      action: 'create',
      status: 'applied',
      credentialHandle: this.handle,
      revision: this.wrongAcknowledgement === 'create' ? 2 : 1,
    };
    this.outcomes.set(input.operationId, { request, outcome });
    this.maybeLoseResponse('create');
    return outcome;
  }

  async rotate(input: KaanaCredentialRotateOperation): Promise<KaanaCredentialOutcome> {
    this.mutationCalls.push({ action: 'rotate', input });
    await this.beforeMutation?.('rotate', input);
    this.maybeConflictOrFail('rotate');
    const request: KaanaCredentialOutcomeRequest = {
      schemaVersion: 1,
      operationId: input.operationId,
      action: 'rotate',
      provider: input.provider,
      ownerAccountId: input.ownerAccountId,
      connectionId: input.connectionId,
      environment: input.environment,
      secretSha256: input.secretSha256,
      credentialHandle: input.credentialHandle,
      expectedRevision: input.expectedRevision,
    };
    const outcome: KaanaCredentialOutcome = {
      schemaVersion: 1,
      operationId: input.operationId,
      action: 'rotate',
      status: 'applied',
      credentialHandle:
        this.wrongAcknowledgement === 'rotate' ? `kcred_${'d'.repeat(26)}` : input.credentialHandle,
      revision: input.expectedRevision + 1,
    };
    this.outcomes.set(input.operationId, { request, outcome });
    this.maybeLoseResponse('rotate');
    return outcome;
  }

  async revoke(input: KaanaCredentialRevokeOperation): Promise<KaanaCredentialOutcome> {
    this.mutationCalls.push({ action: 'revoke', input });
    await this.beforeMutation?.('revoke', input);
    this.maybeConflictOrFail('revoke');
    const request: KaanaCredentialOutcomeRequest = {
      schemaVersion: 1,
      operationId: input.operationId,
      action: 'revoke',
      provider: input.provider,
      ownerAccountId: input.ownerAccountId,
      connectionId: input.connectionId,
      environment: input.environment,
      credentialHandle: input.credentialHandle,
      expectedRevision: input.expectedRevision,
    };
    const outcome: KaanaCredentialOutcome = {
      schemaVersion: 1,
      operationId: input.operationId,
      action: 'revoke',
      status: 'applied',
      credentialHandle: input.credentialHandle,
      revision: input.expectedRevision + (this.wrongAcknowledgement === 'revoke' ? 2 : 1),
    };
    this.outcomes.set(input.operationId, { request, outcome });
    this.maybeLoseResponse('revoke');
    return outcome;
  }

  async outcome(input: KaanaCredentialOutcomeRequest): Promise<KaanaCredentialOutcome> {
    this.outcomeCalls.push(input);
    if (this.outcomeUnavailable) {
      throw new KaanaCredentialOutcomeUnavailableError('outcome unavailable');
    }
    const stored = this.outcomes.get(input.operationId);
    if (stored === undefined || !sameFlatObject(stored.request, input)) {
      throw new KaanaCredentialOutcomeUnavailableError('exact outcome unavailable');
    }
    return stored.outcome;
  }

  private maybeConflictOrFail(action: Action): void {
    if (this.conflictAction === action) {
      throw new KaanaCredentialConflictError('confirmed conflict');
    }
    if (this.failAction === action) throw new Error('network failed before a known commit');
  }

  private maybeLoseResponse(action: Action): void {
    if (this.loseResponseAction === action) {
      throw new KaanaCredentialOutcomeUnavailableError('response lost after commit');
    }
  }
}

function sameFlatObject(left: object, right: object): boolean {
  return JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
}

async function fixture() {
  const tag = suffix();
  const [account] = await getDb()
    .insert(users)
    .values({ username: `kc-${tag}`, email: `kc-${tag}@example.test` })
    .returning({ id: users.id });
  const [application] = await getDb()
    .insert(applications)
    .values({ name: `KC ${tag}`, ownerAccountId: account.id })
    .returning({ id: applications.id });
  const provider = `kcp${tag}`;
  await getDb().insert(inferenceProviders).values({
    slug: provider,
    displayName: 'Kaana Custody Fixture',
    kind: 'customer_byok',
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
    byokTermsAcknowledgementRequired: false,
  });
  return { accountId: account.id, applicationId: application.id, provider };
}

async function createFixture(control: FakeKaanaControl, secret = 'customer-provider-key') {
  const f = await fixture();
  const result = await createProviderConnection(
    {
      provider: f.provider,
      ownerAccountId: f.accountId,
      scopeKind: 'application',
      applicationId: f.applicationId,
      environment: 'production',
      secret: new ProviderCredentialValue(secret),
      acknowledgeProviderTerms: false,
      actor: { kind: 'user', userId: f.accountId },
    },
    control,
  );
  return { ...f, result };
}

async function operationForConnection(connectionId: string) {
  const [operation] = await getDb()
    .select()
    .from(inferenceProviderCredentialOperations)
    .where(eq(inferenceProviderCredentialOperations.connectionId, connectionId));
  if (operation === undefined) throw new Error('fixture operation missing');
  return operation;
}

function voidDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (release === undefined) throw new Error('deferred resolver was not initialized');
  return { promise, resolve: release };
}

async function waitForBlockedConnectionWriters(lockerPid: number, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const blocked = await getDb().execute<{ pid: number }>(sql`
      select pid
      from pg_stat_activity
      where datname = current_database()
        and usename = current_user
        and pid <> ${lockerPid}
        and wait_event_type = 'Lock'
        and query like '%inference_provider_connections%'
    `);
    if (blocked.length >= expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected ${expected} provider-connection writers to wait on the row lock`);
}

describe('Kaana provider connection custody', () => {
  it('persists the exact operation before the network and never persists plaintext', async () => {
    const control = new FakeKaanaControl();
    const plaintext = `provider-key-${randomUUID()}`;
    control.beforeMutation = async (action, input) => {
      const operationId = (input as KaanaCredentialCreateOperation).operationId;
      const [operation] = await getDb()
        .select()
        .from(inferenceProviderCredentialOperations)
        .where(eq(inferenceProviderCredentialOperations.id, operationId));
      const [connection] = await getDb()
        .select()
        .from(inferenceProviderConnections)
        .where(
          eq(
            inferenceProviderConnections.id,
            (input as KaanaCredentialCreateOperation).connectionId,
          ),
        );
      expect(action).toBe('create');
      expect(operation).toMatchObject({ id: operationId, state: 'pending' });
      expect(connection).toMatchObject({ custodyState: 'pending' });
    };
    const { result } = await createFixture(control, plaintext);
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    const operation = await operationForConnection(result.connection.connectionId);
    const call = control.mutationCalls[0];
    expect(operation).toMatchObject({
      id: (call?.input as KaanaCredentialCreateOperation).operationId,
      connectionId: result.connection.connectionId,
      action: 'create',
      provider: result.connection.provider,
      ownerAccountId: result.connection.ownerAccountId,
      environment: 'production',
      operationActor: `user:${result.connection.ownerAccountId}`,
      credentialHandle: null,
      expectedRevision: null,
      state: 'applied',
      outcomeCredentialHandle: control.handle,
      outcomeRevision: 1,
    });
    expect(JSON.stringify(operation)).not.toContain(plaintext);
    expect(JSON.stringify(result.connection)).not.toContain(plaintext);
  });

  it('keeps a network failure under the same durable operation in reconciliation', async () => {
    const control = new FakeKaanaControl();
    control.failAction = 'create';
    const { result, applicationId, provider } = await createFixture(control);
    expect(result.status).toBe('custody-reconcile');
    if (result.status !== 'custody-reconcile') return;
    expect(await operationForConnection(result.connectionId)).toMatchObject({
      action: 'create',
      state: 'reconciliation',
    });
    await expect(
      resolveProviderConnectionForApplication({
        applicationId,
        provider,
        environment: 'production',
      }),
    ).resolves.toEqual({ status: 'none' });
  });

  it('reconciles a lost response through the outcome route without resubmitting', async () => {
    const control = new FakeKaanaControl();
    control.loseResponseAction = 'create';
    const { result } = await createFixture(control);
    expect(result.status).toBe('custody-reconcile');
    if (result.status !== 'custody-reconcile') return;
    const operation = await operationForConnection(result.connectionId);

    const reconciled = await reconcileProviderConnection(result.connectionId, control);
    expect(reconciled.status).toBe('reconciled');
    expect(control.mutationCalls).toHaveLength(1);
    expect(control.outcomeCalls).toHaveLength(1);
    expect(control.outcomeCalls[0]?.operationId).toBe(operation.id);
    expect(await operationForConnection(result.connectionId)).toMatchObject({
      id: operation.id,
      state: 'applied',
      outcomeCredentialHandle: control.handle,
      outcomeRevision: 1,
    });
  });

  it('keeps a 404/network outcome lookup in reconciliation', async () => {
    const control = new FakeKaanaControl();
    control.failAction = 'create';
    const { result } = await createFixture(control);
    expect(result.status).toBe('custody-reconcile');
    if (result.status !== 'custody-reconcile') return;
    control.outcomeUnavailable = true;
    await expect(reconcileProviderConnection(result.connectionId, control)).resolves.toEqual({
      status: 'reconciliation-required',
    });
    expect(await operationForConnection(result.connectionId)).toMatchObject({
      state: 'reconciliation',
    });
  });

  it('moves a confirmed conflict to manual and never guesses an outcome', async () => {
    const control = new FakeKaanaControl();
    control.conflictAction = 'create';
    const { result } = await createFixture(control);
    expect(result.status).toBe('custody-manual');
    if (result.status !== 'custody-manual') return;
    expect(await operationForConnection(result.connectionId)).toMatchObject({ state: 'manual' });
    await expect(reconcileProviderConnection(result.connectionId, control)).resolves.toEqual({
      status: 'manual-required',
    });
    expect(control.outcomeCalls).toHaveLength(0);
  });

  it('quarantines a structurally valid but inexact acknowledgement', async () => {
    const control = new FakeKaanaControl();
    control.wrongAcknowledgement = 'create';
    const { result } = await createFixture(control);
    expect(result.status).toBe('custody-reconcile');
    if (result.status !== 'custody-reconcile') return;
    const [row] = await getDb()
      .select()
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, result.connectionId));
    expect(row).toMatchObject({
      custodyState: 'reconcile',
      credentialHandle: null,
      credentialRevision: null,
    });
  });

  it('fences rotation by exact handle/revision and keeps uncertainty non-routable', async () => {
    const control = new FakeKaanaControl();
    const created = await createFixture(control);
    if (created.result.status !== 'created') throw new Error('fixture create failed');
    const rotated = await rotateProviderConnection(
      {
        connectionId: created.result.connection.connectionId,
        secret: new ProviderCredentialValue('rotated-provider-key'),
        actor: { kind: 'user', userId: created.accountId },
      },
      control,
    );
    expect(rotated.status).toBe('rotated');
    if (rotated.status !== 'rotated') return;
    expect(rotated.connection.credentialRevision).toBe(2);

    control.failAction = 'rotate';
    expect(
      await rotateProviderConnection(
        {
          connectionId: rotated.connection.connectionId,
          secret: new ProviderCredentialValue('another-provider-key'),
          actor: { kind: 'user', userId: created.accountId },
        },
        control,
      ),
    ).toEqual({ status: 'custody-reconcile' });
    expect(
      await resolveProviderConnectionForApplication({
        applicationId: created.applicationId,
        provider: created.provider,
        environment: 'production',
      }),
    ).toEqual({ status: 'none' });
  });

  it('revokes locally first and applies only the exact next revision', async () => {
    const control = new FakeKaanaControl();
    const created = await createFixture(control);
    if (created.result.status !== 'created') throw new Error('fixture create failed');
    const revoked = await revokeProviderConnection(
      {
        connectionId: created.result.connection.connectionId,
        actor: { kind: 'user', userId: created.accountId },
      },
      control,
    );
    expect(revoked.status).toBe('revoked');
    if (revoked.status !== 'revoked') return;
    expect(revoked.connection).toMatchObject({
      status: 'revoked',
      custodyState: 'revoked',
      credentialRevision: 2,
    });
  });

  it.each([
    {
      writer: 'disable',
      run: (connectionId: string, actorId: string) =>
        disableProviderConnection({
          connectionId,
          actor: { kind: 'user', userId: actorId },
        }),
    },
    {
      writer: 'validation',
      run: (connectionId: string, actorId: string) =>
        recordProviderConnectionValidation({
          connectionId,
          state: 'valid',
          actor: { kind: 'user', userId: actorId },
        }),
    },
  ])('does not let a stale $writer writer undo a concurrent revoke fence', async ({ run }) => {
    const control = new FakeKaanaControl();
    const created = await createFixture(control);
    if (created.result.status !== 'created') throw new Error('fixture create failed');
    const connectionId = created.result.connection.connectionId;

    const rowLocked = voidDeferred();
    const releaseRowLock = voidDeferred();
    let lockerPid: number | undefined;
    const lockTransaction = getDb().transaction(async (tx) => {
      const [backend] = await tx.execute<{ pid: number }>(sql`
        select pg_backend_pid()::integer as pid
      `);
      if (backend === undefined) throw new Error('row-lock backend pid is unavailable');
      await tx
        .select({ id: inferenceProviderConnections.id })
        .from(inferenceProviderConnections)
        .where(eq(inferenceProviderConnections.id, connectionId))
        .for('update');
      lockerPid = backend.pid;
      rowLocked.resolve();
      await releaseRowLock.promise;
    });
    await rowLocked.promise;
    if (lockerPid === undefined) throw new Error('row-lock backend pid was not recorded');

    const mutationStarted = voidDeferred();
    const releaseMutation = voidDeferred();
    control.beforeMutation = async (action) => {
      expect(action).toBe('revoke');
      mutationStarted.resolve();
      await releaseMutation.promise;
    };

    const revoke = revokeProviderConnection(
      {
        connectionId,
        actor: { kind: 'user', userId: created.accountId },
      },
      control,
    );
    await waitForBlockedConnectionWriters(lockerPid, 1);

    const statusWrite = run(connectionId, created.accountId);
    await waitForBlockedConnectionWriters(lockerPid, 2);
    releaseRowLock.resolve();
    await lockTransaction;
    await mutationStarted.promise;

    await expect(statusWrite).resolves.toEqual({ status: 'revoked' });
    releaseMutation.resolve();
    await expect(revoke).resolves.toMatchObject({ status: 'revoked' });

    const [row] = await getDb()
      .select()
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, connectionId));
    expect(row).toMatchObject({ status: 'revoked', custodyState: 'revoked' });
  });

  it('leaves an inexact revoke response in reconciliation', async () => {
    const control = new FakeKaanaControl();
    const created = await createFixture(control);
    if (created.result.status !== 'created') throw new Error('fixture create failed');
    control.wrongAcknowledgement = 'revoke';
    expect(
      await revokeProviderConnection(
        {
          connectionId: created.result.connection.connectionId,
          actor: { kind: 'user', userId: created.accountId },
        },
        control,
      ),
    ).toEqual({ status: 'custody-reconcile' });
    const [row] = await getDb()
      .select()
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, created.result.connection.connectionId));
    expect(row).toMatchObject({
      status: 'revoked',
      custodyState: 'reconcile',
      credentialRevision: 1,
    });
  });
});
