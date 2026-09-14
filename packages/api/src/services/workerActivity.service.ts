import { createEcosystemTraffic, type EcosystemTrafficOptions } from '@oxy.so/core/server';
import { normalizeInfrastructureRegion } from '@oxy.so/telemetry/collector';

type Publisher = ReturnType<typeof createEcosystemTraffic>;
let publisher: Publisher | undefined;

/** One explicitly enabled publisher per standalone worker process. */
export function startWorkerActivity(
  service: string,
  ready: () => boolean,
  create: (options: EcosystemTrafficOptions) => Publisher = createEcosystemTraffic,
): Publisher | undefined {
  const enabled = process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED;
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') throw new Error('OXY_ECOSYSTEM_ACTIVITY_ENABLED must be true or false');
  if (enabled !== 'true') return undefined;
  const region = normalizeInfrastructureRegion(process.env.AWS_REGION);
  if (!region) throw new Error('Worker activity requires a valid AWS_REGION');
  if (!process.env.OXY_ACTIVITY_API_KEY || !process.env.OXY_ACTIVITY_API_SECRET) throw new Error('Worker activity requires dedicated OXY_ACTIVITY_API_KEY and OXY_ACTIVITY_API_SECRET');
  if (publisher) throw new Error('Worker activity is already running');
  publisher = create({ service, region, ready });
  publisher.installFetch();
  return publisher;
}

/** Only bounded producer infrastructure metadata crosses into public aggregates. */
export function observeAssetJob(sourceRegion: unknown): void {
  publisher?.record({
    scope: 'internal', direction: 'inbound', activityType: 'media',
    sourceService: 'oxy-api', sourceRegion: normalizeInfrastructureRegion(sourceRegion),
    targetService: 'oxy-asset-variant-worker', targetRegion: process.env.AWS_REGION,
  });
}

export async function stopWorkerActivity(): Promise<void> {
  const current = publisher;
  publisher = undefined;
  await current?.stop();
}
