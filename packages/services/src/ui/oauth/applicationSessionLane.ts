import { publicApplicationSchema } from '@oxy.so/contracts';
import type { OxyServices } from '@oxy.so/core';

export function classifyApplicationSessionLane(metadata: unknown): 'device' | 'oauth' {
  const application = publicApplicationSchema.parse(metadata);
  return application.type === 'third_party' && !application.isOfficial && !application.isInternal ? 'oauth' : 'device';
}

export const APPLICATION_CLASSIFICATION_DEADLINE_MS = 5000;

/** The active registry projection is authoritative; names and origins confer no trust. */
export async function resolveApplicationSessionLane(
  oxyServices: OxyServices,
  clientId: string | null | undefined,
): Promise<'device' | 'oauth'> {
  if (!clientId) throw new Error('A registered clientId is required');
  // The public endpoint rejects inactive applications and unusable credentials.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const metadata = await Promise.race([
      oxyServices.apps.getPublic(clientId, { cache: false }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Application classification timed out')), APPLICATION_CLASSIFICATION_DEADLINE_MS); }),
    ]);
    return classifyApplicationSessionLane(metadata);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
