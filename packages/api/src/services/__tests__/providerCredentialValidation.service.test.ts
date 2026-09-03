import { randomUUID } from 'node:crypto';
import type { KaanaCredentialValidationTask } from '@oxyhq/contracts';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  applications,
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  users,
} from '../../db/schema';
import { inferenceProviderConnections } from '../../db/schema/inferenceProviderConnections';
import { inferenceProviderCredentialValidations } from '../../db/schema/inferenceProviderCredentialValidations';
import { resolveProviderConnectionForApplication } from '../inferenceProviderConnection.service';
import type { KaanaCredentialValidationDispatcher } from '../kaanaCredentialValidation';
import {
  getLatestProviderCredentialValidation,
  listProviderCredentialValidationDeployments,
  recordProviderCredentialValidationOutcome,
  startProviderCredentialValidation,
} from '../providerCredentialValidation.service';

beforeAll(connectPostgres);
afterAll(closePostgres);

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

class RecordingDispatcher implements KaanaCredentialValidationDispatcher {
  readonly tasks: KaanaCredentialValidationTask[] = [];
  unavailable = false;

  async dispatch(task: KaanaCredentialValidationTask): Promise<void> {
    this.tasks.push(task);
    if (this.unavailable) throw new Error('Kaana unavailable after durable commit');
  }
}

async function fixture() {
  const tag = suffix();
  const [account] = await getDb()
    .insert(users)
    .values({ username: `validation-${tag}`, email: `validation-${tag}@example.test` })
    .returning({ id: users.id });
  const [application] = await getDb()
    .insert(applications)
    .values({ name: `Validation ${tag}`, ownerAccountId: account.id })
    .returning({ id: applications.id });
  const provider = `val${tag}`;
  await getDb().insert(inferenceProviders).values({
    slug: provider,
    displayName: 'Validation provider',
    kind: 'customer_byok',
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });
  const publisher = `vpub${tag}`;
  await getDb().insert(inferencePublishers).values({
    slug: publisher,
    displayName: 'Validation publisher',
  });
  const [model] = await getDb()
    .insert(inferenceModels)
    .values({
      publisherSlug: publisher,
      slug: `vmdl${tag}`,
      displayName: 'Validation model',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: false,
      supportsParallelToolCalls: false,
      supportsStructuredOutput: false,
      supportsJsonMode: false,
      supportsReasoning: false,
      supportsStreaming: true,
      supportsPromptCaching: false,
      maxContextTokens: 1024,
      maxOutputTokens: 16,
      licenseId: 'fixture',
      licenseDisplayName: 'Fixture',
      commercialUseAllowed: true,
      requiresAttribution: false,
      releaseKind: 'third_party_hosted',
    })
    .returning({ id: inferenceModels.id });
  const [revision] = await getDb()
    .insert(inferenceModelRevisions)
    .values({ modelId: model.id, revision: `v${tag}`, releasedAt: new Date(), isCurrent: true })
    .returning({ id: inferenceModelRevisions.id });
  const kaanaDeploymentId = `kaana_dep_${tag}`;
  const [deployment] = await getDb()
    .insert(inferenceDeployments)
    .values({
      modelRevisionId: revision.id,
      providerSlug: provider,
      regions: [],
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
      availabilityScope: 'byok_only',
      commercialPermission: 'customer_byok',
      permissionState: 'approved',
      legalReviewStatus: 'approved',
      legalReviewEvidenceRef: `validation/${tag}`,
      legalReviewedAt: new Date(),
      status: 'active',
      internalRouteId: kaanaDeploymentId,
    })
    .returning({ id: inferenceDeployments.id });
  const handle = `kcred_${'a'.repeat(14)}${tag.replace(/[0189]/g, 'a')}`;
  const [connection] = await getDb()
    .insert(inferenceProviderConnections)
    .values({
      provider,
      ownerAccountId: account.id,
      scopeKind: 'application',
      applicationId: application.id,
      environment: 'production',
      status: 'pending_validation',
      custodyState: 'ready',
      credentialHandle: handle,
      credentialRevision: 4,
      validationState: 'unvalidated',
    })
    .returning({ id: inferenceProviderConnections.id });
  return {
    applicationId: application.id,
    accountId: account.id,
    connectionId: connection.id,
    provider,
    deploymentId: deployment.id,
    kaanaDeploymentId,
    handle,
  };
}

describe('durable provider credential bootstrap validation', () => {
  it('requires an exact public deployment, resumes pending work, and revalidates billing without rotation', async () => {
    const f = await fixture();
    const dispatcher = new RecordingDispatcher();
    dispatcher.unavailable = true;

    await expect(
      resolveProviderConnectionForApplication({
        applicationId: f.applicationId,
        provider: f.provider,
        environment: 'production',
      }),
    ).resolves.toEqual({ status: 'none' });

    await expect(
      listProviderCredentialValidationDeployments({
        connectionId: f.connectionId,
        applicationId: f.applicationId,
      }),
    ).resolves.toEqual({ status: 'available', deployments: [{ deploymentId: f.deploymentId }] });

    const first = await startProviderCredentialValidation(
      {
        connectionId: f.connectionId,
        applicationId: f.applicationId,
        deploymentId: f.deploymentId,
      },
      dispatcher,
    );
    expect(first.status).toBe('accepted');
    if (first.status !== 'accepted') throw new Error('validation was not accepted');
    expect(first.dispatch).toBe('retry_required');
    expect(dispatcher.tasks[0]).toMatchObject({
      operationId: first.operation.operationId,
      applicationId: f.applicationId,
      connectionId: f.connectionId,
      provider: f.provider,
      ownerAccountId: f.accountId,
      credentialHandle: f.handle,
      credentialRevision: 4,
      deploymentId: f.kaanaDeploymentId,
    });

    dispatcher.unavailable = false;
    const resumed = await startProviderCredentialValidation(
      {
        connectionId: f.connectionId,
        applicationId: f.applicationId,
        deploymentId: f.deploymentId,
      },
      dispatcher,
    );
    expect(resumed.status).toBe('accepted');
    if (resumed.status !== 'accepted') throw new Error('validation resume was not accepted');
    expect(resumed.operation.operationId).toBe(first.operation.operationId);
    expect(dispatcher.tasks[1]?.operationId).toBe(first.operation.operationId);
    await expect(
      getLatestProviderCredentialValidation({
        connectionId: f.connectionId,
        applicationId: f.applicationId,
      }),
    ).resolves.toEqual(resumed.operation);

    const billing = {
      ...dispatcher.tasks[1]!,
      state: 'inconclusive' as const,
      failureCode: 'forbidden' as const,
    };
    const recordedBilling = await recordProviderCredentialValidationOutcome(billing);
    expect(recordedBilling.status).toBe('recorded');
    await expect(
      resolveProviderConnectionForApplication({
        applicationId: f.applicationId,
        provider: f.provider,
        environment: 'production',
      }),
    ).resolves.toEqual({ status: 'none' });

    const afterTopup = await startProviderCredentialValidation(
      {
        connectionId: f.connectionId,
        applicationId: f.applicationId,
        deploymentId: f.deploymentId,
      },
      dispatcher,
    );
    expect(afterTopup.status).toBe('accepted');
    if (afterTopup.status !== 'accepted') throw new Error('post-top-up validation was not accepted');
    expect(afterTopup.operation.operationId).not.toBe(first.operation.operationId);
    expect(dispatcher.tasks[2]).toMatchObject({
      credentialHandle: f.handle,
      credentialRevision: 4,
    });
    expect(
      await recordProviderCredentialValidationOutcome({
        ...dispatcher.tasks[2]!,
        state: 'valid',
      }),
    ).toMatchObject({ status: 'recorded' });
    const resolved = await resolveProviderConnectionForApplication({
      applicationId: f.applicationId,
      provider: f.provider,
      environment: 'production',
    });
    expect(resolved.status).toBe('resolved');
    if (resolved.status === 'resolved') expect(resolved.connection.connectionId).toBe(f.connectionId);

    expect(
      await recordProviderCredentialValidationOutcome({
        ...dispatcher.tasks[2]!,
        state: 'valid',
      }),
    ).toMatchObject({
      status: 'recorded',
      operation: { operationId: afterTopup.operation.operationId, state: 'valid' },
    });

    const [stored] = await getDb()
      .select()
      .from(inferenceProviderCredentialValidations)
      .where(eq(inferenceProviderCredentialValidations.id, afterTopup.operation.operationId));
    expect(stored).toMatchObject({
      deploymentId: f.deploymentId,
      kaanaDeploymentId: f.kaanaDeploymentId,
      credentialHandle: f.handle,
      credentialRevision: 4,
      state: 'valid',
    });
  });

  it('refuses to replace a pending operation with different exact selectors', async () => {
    const f = await fixture();
    const dispatcher = new RecordingDispatcher();
    const first = await startProviderCredentialValidation(
      {
        connectionId: f.connectionId,
        applicationId: f.applicationId,
        deploymentId: f.deploymentId,
      },
      dispatcher,
    );
    expect(first.status).toBe('accepted');
    await expect(
      startProviderCredentialValidation(
        {
          connectionId: f.connectionId,
          applicationId: f.applicationId,
          deploymentId: randomUUID(),
        },
        dispatcher,
      ),
    ).resolves.toEqual({ status: 'deployment-unavailable' });
    expect(dispatcher.tasks).toHaveLength(1);
  });
});
