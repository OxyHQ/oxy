import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { inferenceProviderConnections } from '../../db/schema/inferenceProviderConnections';
import { inferenceProviders } from '../../db/schema/inferenceProviders';
import { users } from '../../db/schema/users';
import {
  createProviderConnection,
  resolveProviderConnectionForApplication,
  revokeProviderConnection,
  rotateProviderConnection,
} from '../inferenceProviderConnection.service';
import {
  ProviderCredentialValue,
  type CredentialIdentity,
  type KaanaCredentialControl,
  type KaanaCredentialReference,
} from '../kaanaCredentialControl';

beforeAll(connectPostgres);
afterAll(closePostgres);

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

class FakeKaanaControl implements KaanaCredentialControl {
  readonly calls: Array<{ action: string; input: object }> = [];
  failAction?: 'create' | 'rotate' | 'revoke';
  wrongAcknowledgement?: 'create' | 'rotate' | 'revoke';
  revision = 1;
  readonly handle = `kcred_${randomUUID()
    .replace(/-/g, '')
    .replace(/[0189]/g, 'a')
    .slice(0, 26)}`;

  async create(
    input: CredentialIdentity & {
      secret: ProviderCredentialValue;
      actor: object;
    },
  ) {
    this.calls.push({ action: 'create', input });
    if (this.failAction === 'create') throw new Error('ack lost');
    return {
      credentialHandle: this.handle,
      revision: this.wrongAcknowledgement === 'create' ? 2 : this.revision,
    };
  }

  async rotate(
    input: CredentialIdentity &
      KaanaCredentialReference & {
        secret: ProviderCredentialValue;
        actor: object;
      },
  ) {
    this.calls.push({ action: 'rotate', input });
    if (this.failAction === 'rotate') throw new Error('ack lost');
    this.revision = input.revision + 1;
    return {
      credentialHandle:
        this.wrongAcknowledgement === 'rotate' ? `kcred_${'d'.repeat(26)}` : input.credentialHandle,
      revision: this.revision,
    };
  }

  async revoke(input: CredentialIdentity & KaanaCredentialReference & { actor: object }) {
    this.calls.push({ action: 'revoke', input });
    if (this.failAction === 'revoke') throw new Error('ack lost');
    this.revision = input.revision + 1;
    return {
      credentialHandle: input.credentialHandle,
      revision: this.wrongAcknowledgement === 'revoke' ? this.revision + 1 : this.revision,
    };
  }
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

describe('Kaana provider connection custody', () => {
  it('persists only metadata plus the opaque exact handle/revision', async () => {
    const control = new FakeKaanaControl();
    const plaintext = `provider-key-${randomUUID()}`;
    const { result } = await createFixture(control, plaintext);
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.connection).toMatchObject({
      custodyState: 'ready',
      credentialHandle: control.handle,
      credentialRevision: 1,
    });
    expect(JSON.stringify(result.connection)).not.toContain(plaintext);

    const [row] = await getDb()
      .select()
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, result.connection.connectionId));
    expect(JSON.stringify(row)).not.toContain(plaintext);
    expect(row).toMatchObject({ custodyState: 'ready', credentialRevision: 1 });
    expect((control.calls[0]?.input as { actor?: unknown }).actor).toEqual({
      kind: 'user',
      userId: result.connection.ownerAccountId,
    });
  });

  it('quarantines a create whose acknowledgement cannot be proven', async () => {
    const control = new FakeKaanaControl();
    control.failAction = 'create';
    const { result, applicationId, provider } = await createFixture(control);
    expect(result.status).toBe('custody-reconcile');
    if (result.status !== 'custody-reconcile') return;
    const [row] = await getDb()
      .select()
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, result.connectionId));
    expect(row.custodyState).toBe('reconcile');
    await expect(
      resolveProviderConnectionForApplication({
        applicationId,
        provider,
        environment: 'production',
      }),
    ).resolves.toEqual({ status: 'none' });
  });

  it('quarantines a structurally valid but inexact Kaana acknowledgement', async () => {
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

  it('fences rotation by exact handle/revision and leaves uncertain outcomes non-routable', async () => {
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
    const uncertain = await rotateProviderConnection(
      {
        connectionId: rotated.connection.connectionId,
        secret: new ProviderCredentialValue('another-provider-key'),
        actor: { kind: 'user', userId: created.accountId },
      },
      control,
    );
    expect(uncertain.status).toBe('custody-reconcile');
    const resolution = await resolveProviderConnectionForApplication({
      applicationId: created.applicationId,
      provider: created.provider,
      environment: 'production',
    });
    expect(resolution.status).toBe('none');
  });

  it('does not trust a rotate response for a different Kaana handle', async () => {
    const control = new FakeKaanaControl();
    const created = await createFixture(control);
    if (created.result.status !== 'created') throw new Error('fixture create failed');
    control.wrongAcknowledgement = 'rotate';
    const result = await rotateProviderConnection(
      {
        connectionId: created.result.connection.connectionId,
        secret: new ProviderCredentialValue('rotated-provider-key'),
        actor: { kind: 'user', userId: created.accountId },
      },
      control,
    );
    expect(result.status).toBe('custody-reconcile');
    const [row] = await getDb()
      .select()
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, created.result.connection.connectionId));
    expect(row).toMatchObject({
      custodyState: 'reconcile',
      credentialHandle: control.handle,
      credentialRevision: 1,
    });
  });

  it('revokes locally before the Kaana hop and records a successful revision', async () => {
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
    expect(revoked).toMatchObject({ credentialRevoked: true });
    expect(revoked.connection).toMatchObject({
      custodyState: 'revoked',
      credentialRevision: 2,
    });
  });

  it('keeps a revoke in reconcile when Kaana returns the wrong revision', async () => {
    const control = new FakeKaanaControl();
    const created = await createFixture(control);
    if (created.result.status !== 'created') throw new Error('fixture create failed');
    control.wrongAcknowledgement = 'revoke';
    const result = await revokeProviderConnection(
      {
        connectionId: created.result.connection.connectionId,
        actor: { kind: 'user', userId: created.accountId },
      },
      control,
    );
    expect(result.status).toBe('revoked');
    if (result.status !== 'revoked') return;
    expect(result).toMatchObject({ credentialRevoked: false });
    expect(result.connection).toMatchObject({
      status: 'revoked',
      custodyState: 'reconcile',
      credentialRevision: 1,
    });
  });
});
