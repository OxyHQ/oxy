import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { OXY_SERVICE_ENVIRONMENTS } from '@oxy.so/core/server';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applicationWorkloadIdentities } from '../db/schema/applicationWorkloadIdentities';
import { applicationWebOrigins } from '../db/schema/applicationRecognition';
import { managedApplicationDeployments } from '../db/schema/managedApplicationDeployments';
import { declareApplicationWebOrigins } from './applicationRecognition.service';
import {
  bindWorkloadIdentity,
  canonicalWorkloadSubject,
  type WorkloadBindingActor,
} from './workloadIdentityBinding.service';

const declarationSchema = z
  .object({
    deploymentId: z.string().uuid(),
    ownerAccountId: z.string().min(1).max(128),
    origin: z.string().url(),
    environment: z.enum(OXY_SERVICE_ENVIRONMENTS),
    backendRoleArn: z.string(),
    workerRoleArn: z.string(),
    mcpRoleArn: z.string(),
  })
  .strict();
export type ManagedApplicationDeclaration = z.infer<typeof declarationSchema>;
export function parseManagedApplicationDeclaration(input: unknown): ManagedApplicationDeclaration {
  return declarationSchema.parse(input);
}
const roleKeys = ['backendRoleArn', 'workerRoleArn', 'mcpRoleArn'] as const;

/** A staff operator registers a deployment, never an arbitrary HTTP caller or origin. */
export async function registerManagedApplicationDeployment(
  input: ManagedApplicationDeclaration,
  actor: WorkloadBindingActor,
) {
  if (!actor.isPlatformStaff)
    throw new Error('Managed deployment registration requires platform staff');
  const declaration = declarationSchema.parse(input);
  const url = new URL(declaration.origin);
  if (
    url.protocol !== 'https:' ||
    url.origin !== declaration.origin ||
    url.username ||
    url.password
  )
    throw new Error('An exact HTTPS origin is required');
  for (const key of roleKeys) {
    if (canonicalWorkloadSubject('aws-iam', declaration[key]) !== declaration[key])
      throw new Error('Canonical IAM role ARNs are required');
  }
  if (new Set(roleKeys.map((key) => declaration[key])).size !== roleKeys.length)
    throw new Error('Backend, worker and MCP must have distinct IAM roles');

  return getDb().transaction(async (tx) => {
    // Serialize retries of one deployment; origin and subject uniqueness remain
    // enforced by the canonical registries across DIFFERENT deployments.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`managed-application:${declaration.deploymentId}`}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(managedApplicationDeployments)
      .where(eq(managedApplicationDeployments.deploymentId, declaration.deploymentId));
    if (existing) {
      for (const key of [
        'deploymentId',
        'ownerAccountId',
        'origin',
        'environment',
        ...roleKeys,
      ] as const) {
        if (existing[key] !== declaration[key])
          throw new Error(`Deployment declaration drift: ${key}`);
      }
      const [application] = await tx
        .select()
        .from(applications)
        .where(eq(applications.id, existing.applicationId));
      const [credential] = await tx
        .select()
        .from(applicationCredentials)
        .where(eq(applicationCredentials.publicKey, existing.publicClientId));
      const origins = await tx
        .select()
        .from(applicationWebOrigins)
        .where(eq(applicationWebOrigins.applicationId, existing.applicationId));
      const bindings = await tx
        .select()
        .from(applicationWorkloadIdentities)
        .where(eq(applicationWorkloadIdentities.applicationId, existing.applicationId));
      const now = Date.now();
      if (
        !application ||
        application.status !== 'active' ||
        application.type !== 'first_party' ||
        application.ownerAccountId !== declaration.ownerAccountId ||
        !credential ||
        credential.status !== 'active' ||
        credential.type !== 'public' ||
        credential.applicationId !== existing.applicationId ||
        credential.environment !== declaration.environment ||
        (credential.expiresAt && credential.expiresAt.getTime() <= now) ||
        origins.length !== 1 ||
        origins[0].origin !== declaration.origin ||
        bindings.length !== roleKeys.length ||
        roleKeys.some(
          (key) =>
            !bindings.some(
              (binding) =>
                binding.provider === 'aws-iam' &&
                binding.subject === declaration[key] &&
                binding.environment === declaration.environment &&
                (!binding.expiresAt || binding.expiresAt.getTime() > now),
            ),
        )
      )
        throw new Error(
          'Deployment registration was revoked or changed; automatic repair is refused',
        );
      // Deliberately no bind calls: a missing/expired identity is revocation,
      // not a half-finished create, because creation below commits atomically.
      return {
        state: 'unchanged' as const,
        applicationId: existing.applicationId,
        publicClientId: existing.publicClientId,
      };
    }
    const [application] = await tx
      .insert(applications)
      .values({
        name: `Managed Mention ${declaration.deploymentId}`,
        description: 'Dedicated managed Mention deployment',
        type: 'first_party',
        status: 'active',
        isOfficial: true,
        ownerAccountId: declaration.ownerAccountId,
        websiteUrl: declaration.origin,
        redirectUris: [declaration.origin],
        scopes: [],
      })
      .returning();
    if (!application) throw new Error('Application registration failed');
    await declareApplicationWebOrigins(application.id, [declaration.origin], tx);
    const publicClientId = `oxy_dk_${randomBytes(24).toString('hex')}`;
    await tx.insert(applicationCredentials).values({
      applicationId: application.id,
      name: 'Managed Mention web',
      type: 'public',
      publicKey: publicClientId,
      environment: declaration.environment,
      status: 'active',
      scopes: [],
    });
    for (const key of roleKeys) {
      await bindWorkloadIdentity(
        {
          applicationId: application.id,
          subject: declaration[key],
          environment: declaration.environment,
          actor,
        },
        new Date(),
        tx,
      );
    }
    await tx
      .insert(managedApplicationDeployments)
      .values({ ...declaration, applicationId: application.id, publicClientId });
    return { state: 'created' as const, applicationId: application.id, publicClientId };
  });
}
