import { createEcosystemTraffic, type EcosystemTrafficOptions } from '@oxy.so/core/server';
import { normalizeInfrastructureRegion } from '@oxy.so/telemetry/collector';

type Publisher = ReturnType<typeof createEcosystemTraffic>;
let publisher: Publisher | undefined;

/** One publisher per standalone worker process, gated solely on the dedicated activity credential being present. */
export function startWorkerActivity(
  service: string,
  ready: () => boolean,
  create: (options: EcosystemTrafficOptions) => Publisher = createEcosystemTraffic,
): Publisher | undefined {
  if (!process.env.OXY_ACTIVITY_API_KEY?.trim() || !process.env.OXY_ACTIVITY_API_SECRET?.trim()) return undefined;
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
