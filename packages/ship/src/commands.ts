import path from 'node:path';
import {
  stringFlag,
  requireString,
  rolloutFlag,
  platformsFlag,
  type ShipFlags,
} from './args';
import {
  collectPlatformAssets,
  readExportMetadata,
  resolveRuntimeVersion,
  type PlatformBundle,
  type ShipAssetRef,
} from './metadata';
import { runExpoExport, readExpoPublicConfig } from './exec';
import { resolveGitCommit, resolveGitBranch } from './git';
import { createShipClient } from './config';
import type { UpdatePlatform } from '@oxyhq/contracts';

/** Progress goes to stderr so `--json` keeps stdout clean for machine parsing. */
function progress(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Emit the command result: JSON to stdout under `--json`, else a human string. */
function emit(flags: ShipFlags, human: string, json: unknown): void {
  process.stdout.write(flags.json ? `${JSON.stringify(json)}\n` : `${human}\n`);
}

/** De-duplicate the asset set across platforms (content-addressed by sha256). */
function uniqueAssets(bundles: PlatformBundle[]): Map<string, ShipAssetRef> {
  const bySha = new Map<string, ShipAssetRef>();
  for (const bundle of bundles) {
    for (const asset of [bundle.launchAsset, ...bundle.assets]) {
      if (!bySha.has(asset.sha256)) {
        bySha.set(asset.sha256, asset);
      }
    }
  }
  return bySha;
}

export async function publishCommand(flags: ShipFlags): Promise<void> {
  const channel = requireString(flags, 'channel', 'OXY_SHIP_CHANNEL');
  const platforms = platformsFlag(flags);
  const rolloutPercent = rolloutFlag(flags);
  const message = stringFlag(flags, 'message');
  const projectDir = path.resolve(stringFlag(flags, 'project-dir', undefined, '.') as string);
  const distDir = path.resolve(projectDir, stringFlag(flags, 'dist-dir', undefined, 'dist') as string);
  const runtimeOverride = stringFlag(flags, 'runtime-version');
  const gitCommit = resolveGitCommit(projectDir, stringFlag(flags, 'git-commit'));
  const gitBranch = resolveGitBranch(projectDir, stringFlag(flags, 'git-branch'));
  const dryRun = flags['dry-run'] === true;
  const skipExport = flags['skip-export'] === true;

  if (!skipExport) {
    progress(`Exporting (${platforms.join(', ')}) → ${distDir} …`);
    runExpoExport(projectDir, platforms, distDir);
  }

  const config = readExpoPublicConfig(projectDir);
  const runtimeVersion = resolveRuntimeVersion(config, runtimeOverride);

  const metadata = readExportMetadata(distDir);
  const bundles = platforms.map((platform) => collectPlatformAssets(distDir, metadata, platform));
  const bySha = uniqueAssets(bundles);

  progress(
    `Runtime ${runtimeVersion} · channel ${channel} · ${bySha.size} unique assets across ${platforms.length} platform(s)`
  );

  if (dryRun) {
    emit(
      flags,
      `Dry run — ${bySha.size} assets, runtime ${runtimeVersion}, channel ${channel}, platforms ${platforms.join(', ')}. No API calls made.`,
      {
        dryRun: true,
        runtimeVersion,
        channel,
        platforms,
        assetCount: bySha.size,
        gitCommit,
        gitBranch,
      }
    );
    return;
  }

  const client = createShipClient(flags);

  const initItems = [...bySha.values()].map((asset) => ({
    sha256: asset.sha256,
    contentType: asset.contentType,
    size: asset.size,
  }));
  const init = await client.initAssets(initItems);
  progress(`Assets: ${init.existing.length} already stored, ${init.missing.length} to upload.`);

  for (const ticket of init.missing) {
    const asset = bySha.get(ticket.sha256);
    if (!asset) {
      throw new Error(`Server asked for an asset we did not offer: ${ticket.sha256}`);
    }
    await client.uploadAsset(
      ticket.uploadUrl,
      ticket.contentType,
      ticket.cacheControl,
      ticket.checksumSHA256,
      asset.absPath
    );
  }

  const complete = await client.completeAssets([...bySha.keys()]);
  const notUploaded = complete.assets.filter((asset) => asset.status !== 'uploaded');
  if (notUploaded.length > 0) {
    throw new Error(
      `${notUploaded.length} asset(s) failed to upload: ${notUploaded.map((a) => a.sha256.slice(0, 12)).join(', ')}`
    );
  }

  const published = [];
  for (const bundle of bundles) {
    const update = await client.createUpdate({
      channel,
      runtimeVersion,
      platform: bundle.platform,
      launchAsset: {
        sha256: bundle.launchAsset.sha256,
        key: bundle.launchAsset.key,
        contentType: bundle.launchAsset.contentType,
      },
      assets: bundle.assets.map((asset) => ({
        sha256: asset.sha256,
        key: asset.key,
        contentType: asset.contentType,
        ...(asset.fileExtension ? { fileExtension: asset.fileExtension } : {}),
      })),
      extra: { expoClient: config },
      ...(rolloutPercent !== undefined ? { rolloutPercent } : {}),
      ...(gitCommit ? { gitCommit } : {}),
      ...(gitBranch ? { gitBranch } : {}),
      ...(message ? { message } : {}),
    });
    progress(`Published ${bundle.platform}: ${update.id}  (rollout ${update.rolloutPercent}%)`);
    published.push(update);
  }

  emit(
    flags,
    published.map((u) => `${u.platform} ${u.id} (rollout ${u.rolloutPercent}%)`).join('\n'),
    { channel, runtimeVersion, updates: published }
  );
}

export async function rollbackCommand(flags: ShipFlags): Promise<void> {
  const channel = requireString(flags, 'channel', 'OXY_SHIP_CHANNEL');
  const runtimeVersion = requireString(flags, 'runtime-version', 'OXY_SHIP_RUNTIME_VERSION');
  const platform = requirePlatform(flags);
  const client = createShipClient(flags);
  const result = await client.rollback(channel, runtimeVersion, platform);
  emit(
    flags,
    `Rolled back ${result.rolledBack.id}; new head: ${result.head?.id ?? '(none)'}`,
    result
  );
}

export async function rollbackToEmbeddedCommand(flags: ShipFlags): Promise<void> {
  const channel = requireString(flags, 'channel', 'OXY_SHIP_CHANNEL');
  const runtimeVersion = requireString(flags, 'runtime-version', 'OXY_SHIP_RUNTIME_VERSION');
  const platform = requirePlatform(flags);
  const client = createShipClient(flags);
  const result = await client.rollbackToEmbedded(channel, runtimeVersion, platform);
  emit(
    flags,
    `Set rollback-to-embedded on ${channel} for ${runtimeVersion}/${platform}.`,
    result
  );
}

export async function promoteCommand(flags: ShipFlags): Promise<void> {
  const updateId = requireString(flags, 'update-id', 'OXY_SHIP_UPDATE_ID');
  const toChannel = requireString(flags, 'to-channel', 'OXY_SHIP_TO_CHANNEL');
  const rolloutPercent = rolloutFlag(flags);
  const client = createShipClient(flags);
  const update = await client.promote(toChannel, updateId, rolloutPercent);
  emit(
    flags,
    `Promoted ${updateId} → ${toChannel} as ${update.id} (rollout ${update.rolloutPercent}%)`,
    update
  );
}

export async function channelListCommand(flags: ShipFlags): Promise<void> {
  const client = createShipClient(flags);
  const channels = await client.listChannels();
  const human =
    channels.length === 0
      ? 'No channels yet.'
      : channels
          .map((channel) => {
            const rollbacks = channel.rollbacksToEmbedded
              .map((entry) => `${entry.runtimeVersion}/${entry.platform}`)
              .join(', ');
            return `${channel.name}${rollbacks ? `  (rollback-to-embedded: ${rollbacks})` : ''}`;
          })
          .join('\n');
  emit(flags, human, channels);
}

export async function updateListCommand(flags: ShipFlags): Promise<void> {
  const channel = stringFlag(flags, 'channel', 'OXY_SHIP_CHANNEL');
  const runtimeVersion = stringFlag(flags, 'runtime-version');
  const platform = stringFlag(flags, 'platform') as UpdatePlatform | undefined;
  const limitRaw = stringFlag(flags, 'limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const client = createShipClient(flags);
  const updates = await client.listUpdates({
    channel,
    runtimeVersion,
    platform: platform === 'ios' || platform === 'android' ? platform : undefined,
    limit,
  });
  const human =
    updates.length === 0
      ? 'No updates.'
      : updates
          .map(
            (u) =>
              `${u.id}  ${u.channel}  ${u.runtimeVersion}/${u.platform}  ${u.status}  rollout ${u.rolloutPercent}%`
          )
          .join('\n');
  emit(flags, human, updates);
}

function requirePlatform(flags: ShipFlags): UpdatePlatform {
  const value = stringFlag(flags, 'platform', 'OXY_SHIP_PLATFORM');
  if (value !== 'ios' && value !== 'android') {
    throw new Error('--platform must be ios or android for this command');
  }
  return value;
}
