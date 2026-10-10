import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex, md5Hex, contentTypeForExt } from './hash';

/** The subset of `expo export`'s `dist/metadata.json` that oxy-ship consumes. */
export interface ExportMetadata {
  version?: number;
  bundler?: string;
  fileMetadata?: Record<
    string,
    {
      bundle: string;
      assets: Array<{ path: string; ext: string }>;
    }
  >;
}

export type ShipPlatform = 'ios' | 'android';

/** A resolved asset ready to upload + reference in a manifest. */
export interface ShipAssetRef {
  /** Lowercase-hex SHA-256 content address. */
  sha256: string;
  /** expo-export asset key (md5-hex of content). */
  key: string;
  contentType: string;
  /** Leading-dot extension; omitted for the launch asset. */
  fileExtension?: string;
  size: number;
  /** Absolute path on disk (used to stream the bytes at upload time). */
  absPath: string;
}

export interface PlatformBundle {
  platform: ShipPlatform;
  launchAsset: ShipAssetRef;
  assets: ShipAssetRef[];
}

function readAssetRef(
  distDir: string,
  relPath: string,
  options: { isLaunch: true } | { isLaunch: false; ext: string },
): ShipAssetRef {
  const absPath = path.resolve(distDir, relPath);
  const bytes = fs.readFileSync(absPath);
  const sha256 = sha256Hex(bytes);
  const key = md5Hex(bytes);
  if (options.isLaunch) {
    return { sha256, key, contentType: 'application/javascript', size: bytes.length, absPath };
  }
  const ext = options.ext.replace(/^\./, '');
  return {
    sha256,
    key,
    contentType: contentTypeForExt(ext),
    fileExtension: `.${ext}`,
    size: bytes.length,
    absPath,
  };
}

/**
 * Resolve the launch asset + assets for one platform from an `expo export`
 * output directory. Reads each file to compute its real sha256 (content address)
 * and md5 (expo key), so the manifest the server serves is byte-accurate.
 */
export function collectPlatformAssets(
  distDir: string,
  metadata: ExportMetadata,
  platform: ShipPlatform,
): PlatformBundle {
  const fileMetadata = metadata.fileMetadata?.[platform];
  if (!fileMetadata) {
    throw new Error(`metadata.json has no fileMetadata for platform "${platform}"`);
  }
  if (!fileMetadata.bundle) {
    throw new Error(`metadata.json has no bundle for platform "${platform}"`);
  }

  const launchAsset = readAssetRef(distDir, fileMetadata.bundle, { isLaunch: true });
  const assets = (fileMetadata.assets ?? []).map((asset) =>
    readAssetRef(distDir, asset.path, { isLaunch: false, ext: asset.ext }),
  );

  return { platform, launchAsset, assets };
}

/** Read + parse `dist/metadata.json`. */
export function readExportMetadata(distDir: string): ExportMetadata {
  const metadataPath = path.resolve(distDir, 'metadata.json');
  if (!fs.existsSync(metadataPath)) {
    throw new Error(
      `No metadata.json at ${metadataPath}. Run \`expo export\` first (or pass --dist-dir).`,
    );
  }
  return JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as ExportMetadata;
}

/** Unwrap `{ expo: {...} }` vs a bare ExpoConfig from `expo config --json`. */
export function normalizeExpoConfig(parsed: Record<string, unknown>): Record<string, unknown> {
  if (
    parsed &&
    typeof parsed.expo === 'object' &&
    parsed.expo !== null &&
    parsed.version === undefined &&
    parsed.slug === undefined
  ) {
    return parsed.expo as Record<string, unknown>;
  }
  return parsed;
}

/**
 * Resolve the runtime version from the expo config, honouring the `appVersion`
 * policy (the Oxy Updates default). An explicit `override` wins; a concrete
 * string is used verbatim; the `appVersion` policy (or an absent runtimeVersion)
 * resolves to `expo.version`. Non-appVersion policies cannot be resolved without
 * a build, so they require `--runtime-version`.
 */
export function resolveRuntimeVersion(config: Record<string, unknown>, override?: string): string {
  if (override) return override;

  const runtimeVersion = config.runtimeVersion;
  if (typeof runtimeVersion === 'string') {
    return runtimeVersion;
  }
  if (
    runtimeVersion &&
    typeof runtimeVersion === 'object' &&
    'policy' in runtimeVersion &&
    (runtimeVersion as { policy?: string }).policy !== 'appVersion'
  ) {
    throw new Error(
      `runtimeVersion policy "${(runtimeVersion as { policy?: string }).policy}" cannot be resolved by oxy-ship — pass --runtime-version`,
    );
  }
  if (typeof config.version === 'string') {
    return config.version;
  }
  throw new Error('Could not resolve runtimeVersion — set expo.version or pass --runtime-version');
}
