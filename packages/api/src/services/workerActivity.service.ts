import {
  canAttestWorkloadIdentity,
  createEcosystemTraffic,
  type EcosystemTrafficOptions,
} from '@oxy.so/core/server';
import { normalizeInfrastructureRegion } from '@oxy.so/telemetry/collector';

type Publisher = ReturnType<typeof createEcosystemTraffic>;
let publisher: Publisher | undefined;

/**
 * One publisher per standalone worker process, gated on an Oxy identity: the
 * dedicated activity key pair where one is set, or else the task role this
 * process can attest (oxy ADR 0026; `oxy-oxy-asset-variant-worker-task` is bound
 * to the Oxy Media Worker application). Half a pair is no identity.
 */
export function startWorkerActivity(
  service: string,
  ready: () => boolean,
  create: (options: EcosystemTrafficOptions) => Publisher = createEcosystemTraffic,
  canAttest: () => boolean = canAttestWorkloadIdentity,
): Publisher | undefined {
  const key = process.env.OXY_ACTIVITY_API_KEY?.trim();
  const secret = process.env.OXY_ACTIVITY_API_SECRET?.trim();
  if (!(key && secret) && (key || secret || !canAttest())) return undefined;
  const region = normalizeInfrastructureRegion(process.env.AWS_REGION);
  if (!region) throw new Error('Worker activity requires a valid AWS_REGION');
  if (publisher) throw new Error('Worker activity is already running');
  publisher = create({ service, region, ready });
  publisher.installFetch();
  return publisher;
}

/** Only bounded producer infrastructure metadata crosses into public aggregates. */
export function observeAssetJob(sourceRegion: unknown): void {
  publisher?.record({
    scope: 'internal',
    direction: 'inbound',
    activityType: 'media',
    sourceService: 'oxy-api',
    sourceRegion: normalizeInfrastructureRegion(sourceRegion),
    targetService: 'oxy-asset-variant-worker',
    targetRegion: process.env.AWS_REGION,
  });
}

export async function stopWorkerActivity(): Promise<void> {
  const current = publisher;
  publisher = undefined;
  await current?.stop();
}
