/**
 * loadConfig tests — env-driven configuration parsing/validation.
 */

import { normalizeSecp256k1PublicKey } from '@oxyhq/protocol/secp256k1';
import { ConfigError, loadConfig } from '../config';
import { DEFAULT_MAX_BLOB_BYTES, DEFAULT_PORT, PROTOCOL_VERSION } from '@oxyhq/protocol/node';
import { generateTestKeyPair } from './helpers/signEnvelope';

describe('loadConfig', () => {
  const owner = generateTestKeyPair();

  it('throws when the owner public key is absent', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('throws on a malformed owner public key', () => {
    expect(() => loadConfig({ OXY_NODE_OWNER_PUBLIC_KEY: 'not-a-key' })).toThrow(ConfigError);
  });

  it('applies defaults for the optional fields', () => {
    const config = loadConfig({ OXY_NODE_OWNER_PUBLIC_KEY: owner.publicKey });
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.mode).toBe('self-hosted');
    expect(config.maxBlobBytes).toBe(DEFAULT_MAX_BLOB_BYTES);
    expect(config.ownerPublicKey).toBe(owner.publicKey.toLowerCase());
    expect(config.nodePublicKey).toBe(owner.publicKey.toLowerCase());
    expect(config.nodePrivateKey).toBeNull();
    expect(config.protocolId).toBe(PROTOCOL_VERSION);
    expect(config.databasePath.endsWith('node.sqlite')).toBe(true);
  });

  it('parses overrides from the environment', () => {
    const config = loadConfig({
      OXY_NODE_OWNER_PUBLIC_KEY: owner.publicKey,
      OXY_NODE_PORT: '8123',
      OXY_NODE_MODE: 'managed',
      OXY_NODE_MAX_BLOB_BYTES: '1048576',
      OXY_NODE_DB_PATH: '/var/lib/oxy-node/custom.sqlite',
    });
    expect(config.port).toBe(8123);
    expect(config.mode).toBe('managed');
    expect(config.maxBlobBytes).toBe(1048576);
    expect(config.databasePath).toBe('/var/lib/oxy-node/custom.sqlite');
  });

  it('normalizes a COMPRESSED owner key to the uncompressed form a signer emits', () => {
    // Re-encode the owner key in compressed (02|03 + 64 hex) form. A signed
    // envelope always embeds the UNCOMPRESSED key, so without normalization the
    // owner check (a string compare) would never match → all owner writes break.
    const compressed = normalizeSecp256k1PublicKey(owner.publicKey, true);
    const uncompressed = normalizeSecp256k1PublicKey(owner.publicKey);
    expect(compressed.startsWith('02') || compressed.startsWith('03')).toBe(true);
    expect(uncompressed.startsWith('04')).toBe(true);

    const config = loadConfig({ OXY_NODE_OWNER_PUBLIC_KEY: compressed });
    // Resolved owner + node keys are the uncompressed hex the signer derives.
    expect(config.ownerPublicKey).toBe(uncompressed);
    expect(config.nodePublicKey).toBe(uncompressed);
  });

  it('normalizes an explicit compressed node PUBLIC_KEY independently of the owner key', () => {
    const nodeKp = generateTestKeyPair();
    const config = loadConfig({
      OXY_NODE_OWNER_PUBLIC_KEY: owner.publicKey,
      OXY_NODE_PUBLIC_KEY: normalizeSecp256k1PublicKey(nodeKp.publicKey, true),
    });
    expect(config.ownerPublicKey).toBe(owner.publicKey.toLowerCase());
    expect(config.nodePublicKey).toBe(nodeKp.publicKey);
  });

  it('rejects a hex-shaped owner key that is not a valid curve point', () => {
    // Correct compressed shape (02 + 64 hex) but not on the secp256k1 curve.
    const offCurve = `02${'0'.repeat(64)}`;
    expect(() => loadConfig({ OXY_NODE_OWNER_PUBLIC_KEY: offCurve })).toThrow(ConfigError);
  });

  it('rejects an invalid mode and an out-of-range port', () => {
    expect(() => loadConfig({ OXY_NODE_OWNER_PUBLIC_KEY: owner.publicKey, OXY_NODE_MODE: 'cloud' })).toThrow(ConfigError);
    expect(() => loadConfig({ OXY_NODE_OWNER_PUBLIC_KEY: owner.publicKey, OXY_NODE_PORT: '70000' })).toThrow(ConfigError);
  });

  it('defaults the namespace/manifest/collections to the Oxy node shape', () => {
    const config = loadConfig({ OXY_NODE_OWNER_PUBLIC_KEY: owner.publicKey });
    expect(config.appNamespace).toBe('app.oxy');
    expect(config.collections).toEqual([]);
    expect(config.wellKnownPath).toBe('/.well-known/oxy-node.json');
    expect(config.serviceType).toBe('OxyPersonalDataNode');
    expect(config.envPrefix).toBe('OXY_NODE_');
  });

  it('parses a collection allowlist within the app namespace', () => {
    const config = loadConfig({
      OXY_NODE_OWNER_PUBLIC_KEY: owner.publicKey,
      OXY_NODE_APP_NAMESPACE: 'app.mention',
      OXY_NODE_COLLECTIONS: 'app.mention.feed.post, app.mention.feed.like',
    });
    expect(config.appNamespace).toBe('app.mention');
    expect(config.collections).toEqual(['app.mention.feed.post', 'app.mention.feed.like']);
  });

  it('rejects a collection outside the app namespace', () => {
    expect(() =>
      loadConfig({
        OXY_NODE_OWNER_PUBLIC_KEY: owner.publicKey,
        OXY_NODE_APP_NAMESPACE: 'app.mention',
        OXY_NODE_COLLECTIONS: 'app.oxy.identity',
      }),
    ).toThrow(ConfigError);
  });

  it('resolves config from a custom env-var prefix (one base, many app nodes)', () => {
    const config = loadConfig(
      {
        MENTION_NODE_OWNER_PUBLIC_KEY: owner.publicKey,
        MENTION_NODE_APP_NAMESPACE: 'app.mention',
        MENTION_NODE_SERVICE_TYPE: 'MentionDataNode',
        MENTION_NODE_WELL_KNOWN_PATH: '/.well-known/mention-node.json',
      },
      'MENTION_NODE_',
    );
    expect(config.ownerPublicKey).toBe(owner.publicKey.toLowerCase());
    expect(config.appNamespace).toBe('app.mention');
    expect(config.serviceType).toBe('MentionDataNode');
    expect(config.wellKnownPath).toBe('/.well-known/mention-node.json');
    expect(config.envPrefix).toBe('MENTION_NODE_');
  });
});
