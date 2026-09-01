import { createHash, createHmac } from 'node:crypto';
import {
  appCapabilityCatalogSchema,
  type AppCapabilityCatalog,
} from '@oxyhq/contracts';
import { AppCapabilityCatalogRegistration } from '../models/AppCapabilityCatalog';

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

function signingSecret(): string {
  const secret = process.env.CAPABILITY_TICKET_SECRET ?? process.env.ACCESS_TOKEN_SECRET;
  if (!secret) throw new Error('CAPABILITY_TICKET_SECRET or ACCESS_TOKEN_SECRET must be configured');
  return secret;
}

function signRegistration(appId: string, version: string, digest: string): string {
  return createHmac('sha256', signingSecret())
    .update(`oxy-catalog-v1\n${appId}\n${version}\n${digest}`)
    .digest('base64url');
}

export async function registerCapabilityCatalog(input: {
  catalog: unknown;
  applicationId: string;
  credentialId: string;
  deployedAt?: Date;
}) {
  const catalog = appCapabilityCatalogSchema.parse(input.catalog);
  const existingOwner = await AppCapabilityCatalogRegistration.findOne({ appId: catalog.appId });
  if (existingOwner && existingOwner.registeredByApplicationId.toString() !== input.applicationId) {
    throw new Error('Catalog appId is already owned by another application');
  }

  const digest = digestCatalog(catalog);
  const signature = signRegistration(catalog.appId, catalog.version, digest);
  await AppCapabilityCatalogRegistration.updateMany(
    { appId: catalog.appId, active: true },
    { $set: { active: false } },
  );
  return AppCapabilityCatalogRegistration.findOneAndUpdate(
    { appId: catalog.appId, version: catalog.version, digest },
    {
      $set: {
        audience: catalog.audience,
        catalog,
        signature,
        registeredByApplicationId: input.applicationId,
        registeredByCredentialId: input.credentialId,
        deployedAt: input.deployedAt ?? new Date(),
        active: true,
      },
      $setOnInsert: { appId: catalog.appId, version: catalog.version, digest },
    },
    { upsert: true, new: true },
  );
}

export async function activeCapabilityCatalog(appId: string) {
  return AppCapabilityCatalogRegistration.findOne({ appId, active: true });
}

export async function listActiveCapabilityCatalogs(appIds?: readonly string[]) {
  const query: Record<string, unknown> = { active: true };
  if (appIds?.length) query.appId = { $in: [...appIds] };
  return AppCapabilityCatalogRegistration.find(query).sort({ appId: 1 });
}
