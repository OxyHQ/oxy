import { createHash } from 'node:crypto';
import {
  appCapabilityCatalogSchema,
  canonicalCapabilityJson,
  capabilityCatalogBindingSchema,
  type AppCapabilityCatalog,
  type CapabilityCatalogBinding,
} from '@oxy.so/contracts';
import { z } from '@oxy.so/zod4';
import { postOxyServiceJson, type OxyMcpServiceRequestOptions } from './serviceRequest';

const registrationResponseSchema = z
  .object({
    registration: z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      digest: z.string(),
    }),
  })
  .passthrough();

export interface RegisterCapabilityCatalogOptions
  extends Omit<OxyMcpServiceRequestOptions, 'endpoint'> {
  /** Oxy API origin for this environment, e.g. `https://api.oxy.so`. */
  oxyApiUrl: string;
  deployedAt?: Date;
}

/** The digest Oxy and the internal transport both compute for a catalogue. */
export function capabilityCatalogDigest(catalog: AppCapabilityCatalog): string {
  return createHash('sha256').update(canonicalCapabilityJson(catalog)).digest('hex');
}

/**
 * Register the catalogue THIS process serves and return the binding Oxy issues
 * tickets for — the binding `createInternalCatalogMcpHttpService` requires.
 *
 * Oxy upserts on (appId, version, digest), so a process registering at startup
 * is the one source of its own binding: there is no binding to copy into an
 * environment variable and no separate registration task to drift from the
 * code (both failed in production for Mention). A registration whose version or
 * digest is not this catalogue's is refused here rather than served.
 */
export async function registerCapabilityCatalog(
  catalog: AppCapabilityCatalog,
  options: RegisterCapabilityCatalogOptions,
): Promise<CapabilityCatalogBinding> {
  const parsed = appCapabilityCatalogSchema.parse(catalog);
  const { oxyApiUrl, deployedAt, ...request } = options;
  const payload = await postOxyServiceJson(
    { catalog: parsed, deployedAt: (deployedAt ?? new Date()).toISOString() },
    { ...request, endpoint: new URL('/capabilities/catalogs/register', oxyApiUrl).href },
  );
  const { registration } = registrationResponseSchema.parse(payload);
  const binding = capabilityCatalogBindingSchema.parse({
    registrationId: registration.id,
    version: registration.version,
    digest: registration.digest,
  });
  if (binding.version !== parsed.version || binding.digest !== capabilityCatalogDigest(parsed)) {
    throw new Error('Oxy registered a different catalogue than this process serves');
  }
  return binding;
}
