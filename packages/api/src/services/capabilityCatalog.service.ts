import { createHash, sign as signBytes } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  appCapabilityCatalogSchema,
  canonicalCapabilityJson,
  type AppCapabilityCatalog,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { appCapabilityCatalogRegistrations } from '../db/schema/agency';
import { capabilityTicketSigningConfig } from '../config/capabilityTicketSigning';

/** Existing API export retained; all adapters use the same pure serializer. */
export const canonicalCatalogJson = canonicalCapabilityJson;

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

/** Who authorized a registration: an application's credential, or Oxy's own deploy. */
type CatalogRegistrationAuthority =
  | { source: 'credential'; applicationId: string; credentialId: string }
  | { source: 'first_party'; applicationId: string };

async function persistCapabilityCatalog(input: {
  catalog: unknown;
  authority: CatalogRegistrationAuthority;
  deployedAt?: Date;
}) {
  const catalog = appCapabilityCatalogSchema.parse(input.catalog);
  const digest = digestCatalog(catalog);
  const signature = signRegistration(catalog.appId, catalog.version, digest);
  const deployedAt = input.deployedAt ?? new Date();
  const { authority } = input;
  const authorityColumns = {
    source: authority.source,
    registeredByApplicationId: authority.applicationId,
    registeredByCredentialId: authority.source === 'credential' ? authority.credentialId : null,
  };
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`capability-catalog:${catalog.appId}`}, 0))`,
    );
    const [existingOwner] = await tx
      .select({
        registeredByApplicationId: appCapabilityCatalogRegistrations.registeredByApplicationId,
      })
      .from(appCapabilityCatalogRegistrations)
      .where(eq(appCapabilityCatalogRegistrations.appSlug, catalog.appId))
      .limit(1);
    if (existingOwner && existingOwner.registeredByApplicationId !== authority.applicationId) {
      throw new Error('Catalog appId is already owned by another application');
    }
    await tx
      .update(appCapabilityCatalogRegistrations)
      .set({ active: false })
      .where(
        and(
          eq(appCapabilityCatalogRegistrations.appSlug, catalog.appId),
          eq(appCapabilityCatalogRegistrations.active, true),
        ),
      );
    const [registration] = await tx
      .insert(appCapabilityCatalogRegistrations)
      .values({
        appSlug: catalog.appId,
        version: catalog.version,
        audience: catalog.audience,
        catalog,
        digest,
        signature,
        ...authorityColumns,
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
          ...authorityColumns,
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

/** An application registers its own catalogue with its `catalogs:write` credential. */
export function registerCapabilityCatalog(input: {
  authority?: 'first_party' | 'external';
  catalog: unknown;
  applicationId: string;
  credentialId: string;
  deployedAt?: Date;
}) {
  return persistCapabilityCatalog({
    catalog: input.catalog,
    deployedAt: input.deployedAt,
    authority:
      input.authority === 'first_party'
        ? { source: 'first_party', applicationId: input.applicationId }
        : {
            source: 'credential',
            applicationId: input.applicationId,
            credentialId: input.credentialId,
          },
  });
}

/**
 * Oxy's deploy registers a catalogue Oxy itself ships (ADR 0048). There is no
 * credential: the caller is the release running inside Oxy's own VPC, and the
 * owning application is the platform registrar that already holds the namespace.
 */
export function registerFirstPartyCapabilityCatalog(input: {
  catalog: unknown;
  applicationId: string;
  deployedAt?: Date;
}) {
  return persistCapabilityCatalog({
    catalog: input.catalog,
    deployedAt: input.deployedAt,
    authority: { source: 'first_party', applicationId: input.applicationId },
  });
}

export async function activeCapabilityCatalog(appId: string) {
  const [registration] = await getDb()
    .select()
    .from(appCapabilityCatalogRegistrations)
    .where(
      and(
        eq(appCapabilityCatalogRegistrations.appSlug, appId),
        eq(appCapabilityCatalogRegistrations.active, true),
      ),
    )
    .limit(1);
  return registration;
}

export async function listActiveCapabilityCatalogs(appIds?: readonly string[]) {
  const active = eq(appCapabilityCatalogRegistrations.active, true);
  return getDb()
    .select()
    .from(appCapabilityCatalogRegistrations)
    .where(
      appIds?.length
        ? and(active, inArray(appCapabilityCatalogRegistrations.appSlug, [...appIds]))
        : active,
    )
    .orderBy(asc(appCapabilityCatalogRegistrations.appSlug));
}
