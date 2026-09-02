import { createHash, sign as signBytes } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  appCapabilityCatalogSchema,
  type AppCapabilityCatalog,
} from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { appCapabilityCatalogRegistrations } from '../db/schema/agency';
import { capabilityTicketSigningConfig } from '../config/capabilityTicketSigning';

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = canonicalValue(record[key]);
  return sorted;
}

export function canonicalCatalogJson(catalog: AppCapabilityCatalog): string {
  return JSON.stringify(canonicalValue(catalog));
}

export function digestCatalog(catalog: AppCapabilityCatalog): string {
  return createHash('sha256').update(canonicalCatalogJson(catalog)).digest('hex');
}

function signRegistration(appId: string, version: string, digest: string): string {
  const signing = capabilityTicketSigningConfig();
  const signature = signBytes(
    null,
    Buffer.from(`oxy-catalog-v1\n${appId}\n${version}\n${digest}`),
    signing.privateKey,
  );
  return `${signing.keyId}.${signature.toString('base64url')}`;
}

export async function registerCapabilityCatalog(input: {
  catalog: unknown;
  applicationId: string;
  credentialId: string;
  deployedAt?: Date;
}) {
  const catalog = appCapabilityCatalogSchema.parse(input.catalog);
  const digest = digestCatalog(catalog);
  const signature = signRegistration(catalog.appId, catalog.version, digest);
  const deployedAt = input.deployedAt ?? new Date();
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`capability-catalog:${catalog.appId}`}, 0))`);
    const [existingOwner] = await tx
      .select({ registeredByApplicationId: appCapabilityCatalogRegistrations.registeredByApplicationId })
      .from(appCapabilityCatalogRegistrations)
      .where(eq(appCapabilityCatalogRegistrations.appSlug, catalog.appId))
      .limit(1);
    if (existingOwner && existingOwner.registeredByApplicationId !== input.applicationId) {
      throw new Error('Catalog appId is already owned by another application');
    }
    await tx
      .update(appCapabilityCatalogRegistrations)
      .set({ active: false })
      .where(and(
        eq(appCapabilityCatalogRegistrations.appSlug, catalog.appId),
        eq(appCapabilityCatalogRegistrations.active, true),
      ));
    const [registration] = await tx
      .insert(appCapabilityCatalogRegistrations)
      .values({
        appSlug: catalog.appId,
        version: catalog.version,
        audience: catalog.audience,
        catalog,
        digest,
        signature,
        registeredByApplicationId: input.applicationId,
        registeredByCredentialId: input.credentialId,
        deployedAt,
        active: true,
      })
      .onConflictDoUpdate({
        target: [
          appCapabilityCatalogRegistrations.appSlug,
          appCapabilityCatalogRegistrations.version,
          appCapabilityCatalogRegistrations.digest,
        ],
        set: {
          audience: catalog.audience,
          catalog,
          signature,
          registeredByApplicationId: input.applicationId,
          registeredByCredentialId: input.credentialId,
          deployedAt,
          active: true,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!registration) throw new Error('Catalog registration was not persisted');
    return registration;
  });
}

export async function activeCapabilityCatalog(appId: string) {
  const [registration] = await getDb()
    .select()
    .from(appCapabilityCatalogRegistrations)
    .where(and(
      eq(appCapabilityCatalogRegistrations.appSlug, appId),
      eq(appCapabilityCatalogRegistrations.active, true),
    ))
    .limit(1);
  return registration;
}

export async function listActiveCapabilityCatalogs(appIds?: readonly string[]) {
  const active = eq(appCapabilityCatalogRegistrations.active, true);
  return getDb()
    .select()
    .from(appCapabilityCatalogRegistrations)
    .where(appIds?.length
      ? and(active, inArray(appCapabilityCatalogRegistrations.appSlug, [...appIds]))
      : active)
    .orderBy(asc(appCapabilityCatalogRegistrations.appSlug));
}
