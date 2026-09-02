/**
 * Env-driven configuration for an Oxy-protocol data node.
 *
 * This base serves MANY app-node deployments by ENV alone — the Oxy identity
 * node (`OXY_NODE_*`, `app.oxy`), a future Mention node (`MENTION_NODE_*`,
 * `app.mention`), etc. {@link loadConfig} takes an env-var PREFIX so one codebase
 * + one image deploys as any app's node; everything operational comes from the
 * environment, nothing is hardcoded. The owner public key is REQUIRED (it is the
 * verification method that authorizes writes); the process refuses to start
 * without a well-formed one.
 *
 * Recognized variables (shown with the default `OXY_NODE_` prefix):
 *  - `<PREFIX>OWNER_PUBLIC_KEY` (required) — the owner's secp256k1 public key
 *    (hex). Only records signed by this key may be written, and it authorizes
 *    blob pins. Compressed (`02|03` + 64 hex) or uncompressed (`04` + 128 hex).
 *  - `<PREFIX>PUBLIC_KEY` (optional) — the node's own advertised public key
 *    (defaults to the owner key for a self-hosted node).
 *  - `<PREFIX>PRIVATE_KEY` (optional) — the node's own private key, if the node
 *    needs to sign its own liveness/identity material.
 *  - `<PREFIX>MODE` (optional) — `self-hosted` (default) or `managed`.
 *  - `<PREFIX>PORT` (optional) — HTTP port (default {@link DEFAULT_PORT}).
 *  - `<PREFIX>DATA_DIR` (optional) — directory for the SQLite database
 *    (default `<cwd>/data`).
 *  - `<PREFIX>DB_PATH` (optional) — explicit SQLite file path (overrides the
 *    data-dir default).
 *  - `<PREFIX>MAX_BLOB_BYTES` (optional) — max pinned blob size
 *    (default {@link DEFAULT_MAX_BLOB_BYTES}).
 *  - `<PREFIX>APP_NAMESPACE` (optional) — the application namespace served
 *    (default {@link DEFAULT_APP_NAMESPACE}, `app.oxy`). Bounds the collection
 *    allowlist.
 *  - `<PREFIX>COLLECTIONS` (optional) — comma-separated collection allowlist.
 *    EMPTY = accept any collection (the existing Oxy-node behaviour). When set,
 *    EVERY entry MUST be within `APP_NAMESPACE`, and only these collections may
 *    be written / appear in the public log.
 *  - `<PREFIX>WELL_KNOWN_PATH` (optional) — liveness manifest path
 *    (default {@link DEFAULT_WELL_KNOWN_PATH}).
 *  - `<PREFIX>PROTOCOL_ID` (optional) — advertised node-protocol id
 *    (default {@link PROTOCOL_VERSION}).
 *  - `<PREFIX>SERVICE_TYPE` (optional) — advertised DID-document service-type
 *    label (default {@link DEFAULT_SERVICE_TYPE}).
 */

import { join, resolve } from 'node:path';
import { normalizeSecp256k1PublicKey } from '@oxyhq/protocol/secp256k1';
import {
  DEFAULT_APP_NAMESPACE,
  DEFAULT_MAX_BLOB_BYTES,
  DEFAULT_PORT,
  DEFAULT_SERVICE_TYPE,
  DEFAULT_WELL_KNOWN_PATH,
  NODE_MODES,
  PROTOCOL_VERSION,
  type NodeMode,
} from '@oxyhq/protocol/node';

/** Default env-var prefix (the Oxy identity-node deployment). */
export const DEFAULT_ENV_PREFIX = 'OXY_NODE_';

/** Resolved, validated node configuration. */
export interface NodeConfig {
  /** HTTP port to bind. */
  readonly port: number;
  /** The owner's secp256k1 public key (hex) — the sole write authority. */
  readonly ownerPublicKey: string;
  /** The node's advertised public key (defaults to the owner key). */
  readonly nodePublicKey: string;
  /** The node's own private key, when configured (else null). */
  readonly nodePrivateKey: string | null;
  /** Operating mode advertised in the liveness manifest. */
  readonly mode: NodeMode;
  /** Directory holding the SQLite database. */
  readonly dataDir: string;
  /** Absolute path of the SQLite database file. */
  readonly databasePath: string;
  /** Upper bound on a single pinned blob, in bytes. */
  readonly maxBlobBytes: number;
  /** Advertised node-protocol id (the manifest `version`). */
  readonly protocolId: string;
  /** Advertised DID-document service-type label. */
  readonly serviceType: string;
  /** Path the liveness manifest is served at. */
  readonly wellKnownPath: string;
  /** The application namespace this node serves (e.g. `app.oxy`). */
  readonly appNamespace: string;
  /** Collection allowlist (empty = accept any collection within the namespace). */
  readonly collections: readonly string[];
  /** The env-var prefix this config was resolved from. */
  readonly envPrefix: string;
}

/** Thrown when configuration is missing or malformed; the process exits on it. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/;
const UNCOMPRESSED_PUBKEY = /^04[0-9a-f]{128}$/;

/** True for a well-formed compressed or uncompressed secp256k1 public key (hex). */
function isValidPublicKey(value: string): boolean {
  const key = value.toLowerCase();
  return COMPRESSED_PUBKEY.test(key) || UNCOMPRESSED_PUBKEY.test(key);
}

/**
 * Normalize a hex secp256k1 public key to its UNCOMPRESSED form.
 *
 * Signed envelopes always embed the uncompressed key, and the owner check
 * (`isOwnerKey`) compares the configured
 * key against the envelope's key with a constant-time string equality. A
 * compressed configured key (`02|03` + 64 hex) would therefore never match a
 * signed envelope, silently breaking ALL owner-authorized writes. Normalizing at
 * config load makes the configured key the same uncompressed hex the signer emits.
 *
 * @throws {ConfigError} when the key is not a valid secp256k1 curve point.
 */
function normalizePublicKey(value: string, label: string): string {
  const key = value.toLowerCase();
  try {
    return normalizeSecp256k1PublicKey(key);
  } catch {
    throw new ConfigError(`${label} is not a valid secp256k1 public key (not a curve point)`);
  }
}

function parsePort(raw: string | undefined, prefix: string): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`${prefix}PORT must be an integer in 1..65535, got "${raw}"`);
  }
  return port;
}

function parseMode(raw: string | undefined, prefix: string): NodeMode {
  if (raw === undefined || raw.trim() === '') {
    return 'self-hosted';
  }
  const mode = raw.trim();
  if ((NODE_MODES as readonly string[]).includes(mode)) {
    return mode as NodeMode;
  }
  throw new ConfigError(`${prefix}MODE must be one of ${NODE_MODES.join(', ')}, got "${raw}"`);
}

function parseMaxBlobBytes(raw: string | undefined, prefix: string): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_MAX_BLOB_BYTES;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${prefix}MAX_BLOB_BYTES must be a positive integer, got "${raw}"`);
  }
  return value;
}

/** Parse + validate the collection allowlist against the app namespace. */
function parseCollections(raw: string | undefined, appNamespace: string, prefix: string): readonly string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  const collections = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const namespacePrefix = `${appNamespace}.`;
  for (const collection of collections) {
    if (!collection.startsWith(namespacePrefix)) {
      throw new ConfigError(
        `${prefix}COLLECTIONS entry "${collection}" is outside the app namespace "${appNamespace}"`,
      );
    }
  }
  return collections;
}

/**
 * Build a {@link NodeConfig} from the environment.
 *
 * @param env - The environment object (defaults to `process.env`; injectable for tests).
 * @param prefix - The env-var prefix (defaults to {@link DEFAULT_ENV_PREFIX}).
 * @throws {ConfigError} when the owner key is absent/malformed or any value is invalid.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  prefix: string = DEFAULT_ENV_PREFIX,
): NodeConfig {
  const ownerRaw = env[`${prefix}OWNER_PUBLIC_KEY`]?.trim();
  if (!ownerRaw) {
    throw new ConfigError(`${prefix}OWNER_PUBLIC_KEY is required`);
  }
  if (!isValidPublicKey(ownerRaw)) {
    throw new ConfigError(`${prefix}OWNER_PUBLIC_KEY must be a hex secp256k1 public key (compressed or uncompressed)`);
  }
  // Normalize to uncompressed hex so a compressed configured key still matches
  // the (always-uncompressed) key embedded in a signed envelope's owner check.
  const ownerPublicKey = normalizePublicKey(ownerRaw, `${prefix}OWNER_PUBLIC_KEY`);

  const nodePublicRaw = env[`${prefix}PUBLIC_KEY`]?.trim();
  if (nodePublicRaw && !isValidPublicKey(nodePublicRaw)) {
    throw new ConfigError(`${prefix}PUBLIC_KEY must be a hex secp256k1 public key (compressed or uncompressed)`);
  }
  const nodePublicKey = nodePublicRaw
    ? normalizePublicKey(nodePublicRaw, `${prefix}PUBLIC_KEY`)
    : ownerPublicKey;

  const nodePrivateRaw = env[`${prefix}PRIVATE_KEY`]?.trim();
  const nodePrivateKey = nodePrivateRaw ? nodePrivateRaw.toLowerCase() : null;

  const dataDir = resolve(env[`${prefix}DATA_DIR`]?.trim() || join(process.cwd(), 'data'));
  const dbPathRaw = env[`${prefix}DB_PATH`]?.trim();
  const databasePath = dbPathRaw ? resolve(dbPathRaw) : join(dataDir, 'node.sqlite');

  const appNamespace = env[`${prefix}APP_NAMESPACE`]?.trim() || DEFAULT_APP_NAMESPACE;
  const collections = parseCollections(env[`${prefix}COLLECTIONS`], appNamespace, prefix);

  const wellKnownRaw = env[`${prefix}WELL_KNOWN_PATH`]?.trim();
  if (wellKnownRaw && !wellKnownRaw.startsWith('/')) {
    throw new ConfigError(`${prefix}WELL_KNOWN_PATH must be an absolute path beginning with "/", got "${wellKnownRaw}"`);
  }
  const wellKnownPath = wellKnownRaw || DEFAULT_WELL_KNOWN_PATH;

  return {
    port: parsePort(env[`${prefix}PORT`], prefix),
    ownerPublicKey,
    nodePublicKey,
    nodePrivateKey,
    mode: parseMode(env[`${prefix}MODE`], prefix),
    dataDir,
    databasePath,
    maxBlobBytes: parseMaxBlobBytes(env[`${prefix}MAX_BLOB_BYTES`], prefix),
    protocolId: env[`${prefix}PROTOCOL_ID`]?.trim() || PROTOCOL_VERSION,
    serviceType: env[`${prefix}SERVICE_TYPE`]?.trim() || DEFAULT_SERVICE_TYPE,
    wellKnownPath,
    appNamespace,
    collections,
    envPrefix: prefix,
  };
}
