import { stripPublicPrefix } from '../config/cdn';

/** A validated content root owns all profiles and HLS segments beneath it. */
export function variantStorageRoot(key: string, sha256: string): string | undefined {
  const base = stripPublicPrefix(key);
  if (base.split('/').some((part) => part === '.' || part === '..')) return undefined;
  const match = /^(variants\/\d{4}\/\d{2}\/[0-9a-f]{2}\/([0-9a-f]{64})\/)/.exec(base);
  return match?.[2] === sha256 ? match[1] : undefined;
}

/** Historical roots remain owned across re-encoding, twin copying and calendar changes. */
export function videoStorageRoots(
  asset: { sha256: string; metadata?: Record<string, unknown> | null },
  keys: readonly string[] = [],
): string[] {
  const video = asset.metadata?.video;
  const recorded =
    video &&
    typeof video === 'object' &&
    'storageRoots' in video &&
    Array.isArray(video.storageRoots)
      ? video.storageRoots.filter((value): value is string => typeof value === 'string')
      : [];
  return [
    ...new Set(
      [...recorded, ...keys].flatMap((key) => {
        const root = variantStorageRoot(key, asset.sha256);
        return root ? [root] : [];
      }),
    ),
  ];
}
