import type { ExperimentalMutationOwner } from './experimentalOwnedMutationCache';
import type { ExperimentalOwnedMutationRegistry } from './experimentalOwnedMutationRegistry';

type Checkpoint = (owner: ExperimentalMutationOwner, isCurrent: () => boolean) => Promise<boolean>;
const KIND = 'oxy.device.rename.v1';

function parse(value: unknown): { deviceName: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as { deviceName?: unknown };
  if (
    Object.keys(entry).some((key) => key !== 'deviceName') ||
    typeof entry.deviceName !== 'string'
  )
    return null;
  const deviceName = entry.deviceName.trim();
  return deviceName ? { deviceName } : null;
}

/**
 * An experimental consumer for the existing device-name endpoint. The target
 * session comes from the captured owner binding, never from a caller-supplied
 * session id. The caller must provide a unique operation id and a durable
 * checkpoint. This is not wired to a provider or a supported public hook.
 * Device names are user-supplied strings and may themselves contain secrets.
 */
export function createExperimentalOwnedDeviceRename(
  registry: ExperimentalOwnedMutationRegistry,
  checkpoint: Checkpoint,
  options: { updateLocalName?: (name: string, isCurrent: () => boolean) => Promise<void> } = {},
) {
  registry.register(KIND, {
    accepts: (payload) => parse(payload) !== null,
    codec: {
      version: 1,
      encode: (payload) => {
        const result = parse(payload);
        if (!result) throw new Error('Invalid device name');
        return result;
      },
      decode: (payload) => parse(payload),
    },
    run: async (payload, context) => {
      const parsed = parse(payload);
      if (!parsed) throw new Error('Invalid device name');
      const result = await context.request({
        method: 'PUT',
        url: `/session/device/name/${encodeURIComponent(context.owner.sessionId)}`,
        data: parsed,
      });
      if (
        !result ||
        typeof result !== 'object' ||
        (result as { success?: unknown }).success !== true ||
        (result as { deviceName?: unknown }).deviceName !== parsed.deviceName
      )
        throw new Error('Unexpected device rename response');
      return result;
    },
    commit: async (result, context) => {
      if (!options.updateLocalName) return;
      if (!context.isCurrent()) throw new Error('Mutation owner changed');
      const name = (result as { deviceName: string }).deviceName;
      await options.updateLocalName(name, context.isCurrent);
      if (!context.isCurrent()) throw new Error('Mutation owner changed');
    },
  });
  return {
    async rename(id: string, deviceName: string): Promise<void> {
      const payload = parse({ deviceName });
      if (!payload) throw new Error('Invalid device name');
      await registry.enqueueDurably(id, KIND, payload, checkpoint);
      await registry.executeDurably(id, checkpoint);
    },
  };
}
