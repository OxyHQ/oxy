#!/usr/bin/env bun
/**
 * Register the capability catalogue Oxy itself ships (`oxyProfileCapabilityCatalog`)
 * with the code that is deploying (ADR 0048). `deploy-aws.yml` runs it after
 * every rollout as a post-deploy one-shot task, inside the VPC, so the registered
 * catalogue can never lag the image that reads it.
 *
 * Idempotent: the registration is keyed by (app, version, digest), so a second
 * run over the same code changes nothing but `deployedAt`.
 *
 * Prints `OXY_CATALOG_BINDING_JSON=<binding>`: the exact value an app that pins
 * the catalogue (Mention's `MENTION_OXY_FOREGROUND_CATALOG_BINDING`) must carry.
 *
 * Env: DATABASE_URL (required).
 */

import { capabilityCatalogBindingSchema } from '@oxy.so/contracts';
import { oxyProfileCapabilityCatalog } from '../src/capabilities/oxy-profile.catalog';
import { closePostgres, connectPostgres } from '../src/config/postgres';
import { registerFirstPartyCapabilityCatalog } from '../src/services/capabilityCatalog.service';
import { OXY_PROFILE_REGISTRAR_APPLICATION_ID } from '../src/scripts/seedOxyApplicationsSpecs';
import { logger } from '../src/utils/logger';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL is required');
    process.exit(1);
  }
  await connectPostgres();
  try {
    const registration = await registerFirstPartyCapabilityCatalog({
      catalog: oxyProfileCapabilityCatalog(),
      applicationId: OXY_PROFILE_REGISTRAR_APPLICATION_ID,
    });
    const binding = capabilityCatalogBindingSchema.parse({
      registrationId: registration.id,
      version: registration.version,
      digest: registration.digest,
    });
    process.stdout.write(`OXY_CATALOG_BINDING_JSON=${JSON.stringify(binding)}\n`);
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error(
      'Oxy capability catalog registration failed',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
