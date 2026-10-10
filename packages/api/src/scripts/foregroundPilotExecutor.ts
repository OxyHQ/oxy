import { canonicalCapabilityJson } from '@oxy.so/contracts';
/** One reviewed operation, no retry. Invoked from the pinned final API image by its own ECS task. */
import { and, eq } from 'drizzle-orm';
import { oxyProfileCapabilityCatalog } from '../capabilities/oxy-profile.catalog';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { appCapabilityCatalogRegistrations } from '../db/schema/agency';
import { digestCatalog } from '../services/capabilityCatalog.service';
import {
  type ForegroundPilotPlan,
  applyForegroundPilotConfiguration,
  createEphemeralRegistrarCredential,
  retireEphemeralRegistrarCredentials,
  rollbackForegroundPilotConfiguration,
  validateForegroundPilotPlan,
} from './foregroundPilotConfiguration';
import { ForegroundPilotHttps } from './foregroundPilotHttps';
import { OXY_PROFILE_REGISTRAR_APPLICATION_ID } from './seedOxyApplicationsSpecs';

type Phase =
  | 'configuration-intent'
  | 'configuration-confirmed'
  | 'credential-intent'
  | 'credential-confirmed'
  | 'mint-intent'
  | 'mint-confirmed'
  | 'register-intent'
  | 'register-confirmed'
  | 'cleanup-confirmed';
export async function executeForegroundPilot(
  plan: ForegroundPilotPlan,
  record: (phase: Phase) => Promise<void>,
  signal?: AbortSignal,
  https = new ForegroundPilotHttps(),
) {
  validateForegroundPilotPlan(plan);
  const catalog = oxyProfileCapabilityCatalog();
  if (catalog.internalBaseUrl !== 'https://api.oxy.so')
    throw new Error('I05 canonical catalogue origin required');
  let applied = false;
  try {
    await record('configuration-intent');
    if (signal?.aborted) throw new Error('I05 operation cancelled');
    await applyForegroundPilotConfiguration(plan);
    applied = true;
    await record('configuration-confirmed');
    validateForegroundPilotPlan(plan);
    if (signal?.aborted) throw new Error('I05 operation cancelled');
    await registerForegroundPilotCatalog(plan, record, signal, https);
  } finally {
    if (applied) {
      await retireEphemeralRegistrarCredentials(plan);
      await record('cleanup-confirmed');
    }
  }
}

/** Requires the exact configured machine; never creates application authority. */
export async function registerForegroundPilotCatalog(
  plan: ForegroundPilotPlan,
  record: (phase: Phase) => Promise<void>,
  signal?: AbortSignal,
  https = new ForegroundPilotHttps(),
) {
  validateForegroundPilotPlan(plan);
  const catalog = oxyProfileCapabilityCatalog();
  if (catalog.internalBaseUrl !== 'https://api.oxy.so')
    throw new Error('I05 canonical catalogue origin required');
  try {
    await record('credential-intent');
    if (signal?.aborted) throw new Error('I05 operation cancelled');
    const credential = await createEphemeralRegistrarCredential(plan);
    try {
      await record('credential-confirmed');
      validateForegroundPilotPlan(plan);
      await record('mint-intent');
      validateForegroundPilotPlan(plan);
      if (signal?.aborted) throw new Error('I05 operation cancelled');
      const token = await https.mint(credential, signal);
      await record('mint-confirmed');
      validateForegroundPilotPlan(plan);
      await record('register-intent');
      validateForegroundPilotPlan(plan);
      if (signal?.aborted) throw new Error('I05 operation cancelled');
      await https.register(catalog, token, signal);
      const rows = await getDb()
        .select()
        .from(appCapabilityCatalogRegistrations)
        .where(
          and(
            eq(appCapabilityCatalogRegistrations.appSlug, 'oxy'),
            eq(appCapabilityCatalogRegistrations.active, true),
          ),
        );
      const registration = rows[0];
      if (
        rows.length !== 1 ||
        !registration ||
        registration.registeredByApplicationId !== OXY_PROFILE_REGISTRAR_APPLICATION_ID ||
        registration.registeredByCredentialId !== credential.id ||
        registration.digest !== digestCatalog(catalog) ||
        canonicalCapabilityJson(registration.catalog) !== canonicalCapabilityJson(catalog)
      ) {
        throw new Error('I05 catalogue readback mismatch');
      }
      await record('register-confirmed');
    } finally {
      // Strings remain only in process memory, never in records or durable files.
      credential.secret = '';
    }
  } finally {
    await retireEphemeralRegistrarCredentials(plan);
  }
}

async function main() {
  const [operation, encoded, ...rest] = process.argv.slice(2);
  if (
    !['execute', 'rollback', 'retire'].includes(operation ?? '') ||
    !encoded ||
    rest.length ||
    encoded.length > 65_536 ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  )
    throw new Error('I05 exact operation and base64url plan required');
  const plan = JSON.parse(
    Buffer.from(encoded, 'base64url').toString('utf8'),
  ) as ForegroundPilotPlan;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGTERM', abort);
  process.on('SIGINT', abort);
  try {
    await connectPostgres();
    // Abort blocks new effects; financial/database namespace is checked by canonical connect.
    if (operation === 'execute') {
      await executeForegroundPilot(
        plan,
        async (phase) => {
          await new Promise<void>((resolve, reject) =>
            process.stdout.write(
              `${JSON.stringify({
                kind: 'i05-foreground-operation',
                nonce: plan.nonce,
                phase,
              })}\n`,
              (error) => (error ? reject(error) : resolve()),
            ),
          );
        },
        controller.signal,
      );
    } else if (operation === 'rollback') await rollbackForegroundPilotConfiguration(plan);
    else await retireEphemeralRegistrarCredentials(plan);
    console.log(
      JSON.stringify({
        kind: 'i05-foreground-operation',
        nonce: plan.nonce,
        operation,
        status: 'confirmed',
      }),
    );
  } finally {
    await closePostgres();
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }
}
if (require.main === module) {
  void main().catch(() => {
    console.error('I05_FOREGROUND_OPERATION_FAILED_RECONCILE_REQUIRED');
    process.exitCode = 1;
  });
}
