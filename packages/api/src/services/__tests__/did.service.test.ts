/**
 * Unit tests for the DID document service (B2).
 *
 * Pure functions over plain objects — no DB. Asserts the self-sovereign vs.
 * custodial controller/verification-method derivation, the `alsoKnownAs`/service
 * composition, and the Oxy organisation document.
 */

import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import { buildUserDid, buildDidDocument, buildOxyDidDocument, OXY_DID } from '../did.service';
import { didDocumentSchema } from '@oxyhq/contracts';


function newPublicKey(): string {
  return generateSecp256k1KeyPair().publicKey;
}

const ORIGINAL_OXY_PUBLIC_KEY = process.env.OXY_PUBLIC_KEY;

afterEach(() => {
  if (ORIGINAL_OXY_PUBLIC_KEY === undefined) {
    delete process.env.OXY_PUBLIC_KEY;
  } else {
    process.env.OXY_PUBLIC_KEY = ORIGINAL_OXY_PUBLIC_KEY;
  }
});

describe('buildUserDid', () => {
  it('anchors the DID on the account id, not the keypair', () => {
    expect(buildUserDid('507f1f77bcf86cd799439011')).toBe('did:web:oxy.so:u:507f1f77bcf86cd799439011');
  });
});

describe('buildDidDocument — self-sovereign account', () => {
  const publicKey = newPublicKey();
  const user = {
    _id: '507f1f77bcf86cd799439011',
    publicKey,
    username: 'nate',
    authMethods: [{ type: 'identity', metadata: { publicKey } }],
    verifiedDomains: [{ domain: 'nate.com' }],
    type: 'local',
  };

  it('produces a contract-valid document controlled by [userDid, OXY_DID]', () => {
    const doc = buildDidDocument(user);
    expect(() => didDocumentSchema.parse(doc)).not.toThrow();

    const did = buildUserDid(user._id);
    expect(doc.id).toBe(did);
    expect(doc.controller).toEqual([did, OXY_DID]);
  });

  it('exposes the account key as the #key-1 verification method + active auth', () => {
    const doc = buildDidDocument(user);
    const did = buildUserDid(user._id);

    expect(doc.verificationMethod).toHaveLength(1);
    expect(doc.verificationMethod[0]).toMatchObject({
      id: `${did}#key-1`,
      type: 'EcdsaSecp256k1VerificationKey2019',
      controller: did,
      publicKeyHex: publicKey,
    });
    expect(doc.authentication).toEqual([`${did}#key-1`]);
    expect(doc.assertionMethod).toEqual([`${did}#key-1`]);
  });

  it('includes acct handle, profile URL, and verified-domain in alsoKnownAs', () => {
    const doc = buildDidDocument(user);
    expect(doc.alsoKnownAs).toContain('acct:nate@oxy.so');
    expect(doc.alsoKnownAs).toContain('https://oxy.so/@nate');
    expect(doc.alsoKnownAs).toContain('https://nate.com');
  });

  it('publishes Oxy API + profile service endpoints', () => {
    const doc = buildDidDocument(user);
    const did = buildUserDid(user._id);
    expect(doc.service).toContainEqual({
      id: `${did}#oxy-api`,
      type: 'OxyApiService',
      serviceEndpoint: 'https://api.oxy.so',
    });
    expect(doc.service).toContainEqual({
      id: `${did}#profile`,
      type: 'OxyProfileService',
      serviceEndpoint: 'https://oxy.so/@nate',
    });
  });
});

describe('buildDidDocument — custodial (password-only) account', () => {
  const user = {
    _id: '507f1f77bcf86cd799439012',
    username: 'paula',
    authMethods: [{ type: 'password', metadata: { email: 'paula@oxy.so' } }],
    type: 'local',
  };

  it('is controlled solely by OXY_DID and references the Oxy custodial key', () => {
    process.env.OXY_PUBLIC_KEY = newPublicKey();
    const doc = buildDidDocument(user);
    expect(() => didDocumentSchema.parse(doc)).not.toThrow();

    expect(doc.controller).toEqual([OXY_DID]);
    expect(doc.verificationMethod).toHaveLength(1);
    expect(doc.verificationMethod[0]).toMatchObject({
      id: `${OXY_DID}#oxy-custodial-key`,
      controller: OXY_DID,
      publicKeyHex: process.env.OXY_PUBLIC_KEY,
    });
    expect(doc.authentication).toEqual([`${OXY_DID}#oxy-custodial-key`]);
  });

  it('emits an empty verification-method set when no Oxy key is configured', () => {
    delete process.env.OXY_PUBLIC_KEY;
    const doc = buildDidDocument(user);
    expect(() => didDocumentSchema.parse(doc)).not.toThrow();
    expect(doc.controller).toEqual([OXY_DID]);
    expect(doc.verificationMethod).toEqual([]);
    expect(doc.authentication).toEqual([]);
  });
});

describe('buildDidDocument — webauthn stays CUSTODIAL (Fase B/b1)', () => {
  // A passkey is NOT a DID verification method: `collectIdentityKeys` must never
  // read a `webauthn` auth-method row, so a passkey-only account remains
  // custodial (controlled solely by OXY_DID), exactly like a password-only one.
  const webauthnOnlyUser = {
    _id: '507f1f77bcf86cd799439013',
    username: 'wren',
    authMethods: [{ type: 'webauthn', metadata: { credentialID: 'passkey-abc', name: 'Laptop' } }],
    type: 'local',
  };

  it('is controlled solely by OXY_DID and derives NO self-key verification method from the passkey', () => {
    delete process.env.OXY_PUBLIC_KEY;
    const doc = buildDidDocument(webauthnOnlyUser);
    const did = buildUserDid(webauthnOnlyUser._id);

    expect(() => didDocumentSchema.parse(doc)).not.toThrow();
    expect(doc.controller).toEqual([OXY_DID]);
    // No verification method carries the passkey (no #key-1, no credential id).
    expect(doc.verificationMethod).toEqual([]);
    expect(doc.verificationMethod.some((vm) => vm.id === `${did}#key-1`)).toBe(false);
    expect(JSON.stringify(doc)).not.toContain('passkey-abc');
  });

  it('a password + passkey account is still custodial (the passkey adds no key)', () => {
    process.env.OXY_PUBLIC_KEY = newPublicKey();
    const doc = buildDidDocument({
      _id: '507f1f77bcf86cd799439014',
      username: 'pax',
      authMethods: [
        { type: 'password', metadata: { email: 'pax@oxy.so' } },
        { type: 'webauthn', metadata: { credentialID: 'passkey-def' } },
      ],
      type: 'local',
    });

    expect(doc.controller).toEqual([OXY_DID]);
    // Only the Oxy custodial key — nothing derived from the passkey.
    expect(doc.verificationMethod).toHaveLength(1);
    expect(doc.verificationMethod[0]?.id).toBe(`${OXY_DID}#oxy-custodial-key`);
  });
});

describe('buildOxyDidDocument', () => {
  it('returns the Oxy organisation DID document', () => {
    process.env.OXY_PUBLIC_KEY = newPublicKey();
    const doc = buildOxyDidDocument();
    expect(() => didDocumentSchema.parse(doc)).not.toThrow();
    expect(doc.id).toBe(OXY_DID);
    expect(doc.controller).toEqual([OXY_DID]);
    expect(doc.verificationMethod[0]?.publicKeyHex).toBe(process.env.OXY_PUBLIC_KEY);
  });
});

describe('DID_WEB_DOMAIN override', () => {
  // The DID-web domain is read at module-load time, so a fresh module registry
  // is required to exercise a different `DID_WEB_DOMAIN`.
  const ORIGINAL_DID_WEB_DOMAIN = process.env.DID_WEB_DOMAIN;

  afterEach(() => {
    if (ORIGINAL_DID_WEB_DOMAIN === undefined) {
      delete process.env.DID_WEB_DOMAIN;
    } else {
      process.env.DID_WEB_DOMAIN = ORIGINAL_DID_WEB_DOMAIN;
    }
    jest.resetModules();
  });

  async function loadDidServiceFresh(): Promise<typeof import('../did.service')> {
    let mod: typeof import('../did.service') | undefined;
    await jest.isolateModulesAsync(async () => {
      mod = await import('../did.service');
    });
    if (!mod) {
      throw new Error('did.service failed to load under isolateModules');
    }
    return mod;
  }

  it('anchors every did:web id at DID_WEB_DOMAIN while keeping federation URLs on oxy.so', async () => {
    process.env.DID_WEB_DOMAIN = 'api.oxy.so';
    const fresh = await loadDidServiceFresh();

    expect(fresh.OXY_DID).toBe('did:web:api.oxy.so');
    expect(fresh.buildUserDid('507f1f77bcf86cd799439011')).toBe(
      'did:web:api.oxy.so:u:507f1f77bcf86cd799439011',
    );

    const publicKey = newPublicKey();
    const did = 'did:web:api.oxy.so:u:507f1f77bcf86cd799439011';
    const doc = fresh.buildDidDocument({
      _id: '507f1f77bcf86cd799439011',
      publicKey,
      username: 'nate',
      authMethods: [{ type: 'identity', metadata: { publicKey } }],
      verifiedDomains: [{ domain: 'nate.com' }],
      type: 'local',
    });

    // DID id, controllers, verification-method ids, and service ids all follow
    // the DID-web domain.
    expect(doc.id).toBe(did);
    expect(doc.controller).toEqual([did, 'did:web:api.oxy.so']);
    expect(doc.verificationMethod[0]?.id).toBe(`${did}#key-1`);
    expect(doc.service.map((s) => s.id)).toEqual([`${did}#oxy-api`, `${did}#profile`]);

    // Federation-anchored handles/URLs/endpoints STAY on the federation apex.
    expect(doc.alsoKnownAs).toContain('acct:nate@oxy.so');
    expect(doc.alsoKnownAs).toContain('https://oxy.so/@nate');
    expect(doc.service).toContainEqual({
      id: `${did}#oxy-api`,
      type: 'OxyApiService',
      serviceEndpoint: 'https://api.oxy.so',
    });
    expect(doc.service).toContainEqual({
      id: `${did}#profile`,
      type: 'OxyProfileService',
      serviceEndpoint: 'https://oxy.so/@nate',
    });

    const orgDoc = fresh.buildOxyDidDocument();
    expect(orgDoc.id).toBe('did:web:api.oxy.so');
    expect(orgDoc.controller).toEqual(['did:web:api.oxy.so']);
    expect(orgDoc.service[0]?.serviceEndpoint).toBe('https://api.oxy.so');
  });

  it('defaults to did:web:oxy.so when DID_WEB_DOMAIN is unset', async () => {
    delete process.env.DID_WEB_DOMAIN;
    const fresh = await loadDidServiceFresh();

    expect(fresh.OXY_DID).toBe('did:web:oxy.so');
    expect(fresh.buildUserDid('507f1f77bcf86cd799439011')).toBe(
      'did:web:oxy.so:u:507f1f77bcf86cd799439011',
    );
  });

  it('parseUserDid accepts BOTH the DID_WEB_DOMAIN anchor and the canonical identity apex', async () => {
    process.env.DID_WEB_DOMAIN = 'api.oxy.so';
    const fresh = await loadDidServiceFresh();
    const id = '507f1f77bcf86cd799439011';

    // The server-emitted spelling.
    expect(fresh.parseUserDid(`did:web:api.oxy.so:u:${id}`)).toBe(id);
    // The SDK spelling (@oxyhq/core OXY_IDENTITY_APEX) — client-signed envelopes
    // arrive anchored at the identity apex regardless of DID_WEB_DOMAIN.
    expect(fresh.parseUserDid(`did:web:oxy.so:u:${id}`)).toBe(id);

    // Foreign domains and malformed ids stay rejected.
    expect(fresh.parseUserDid(`did:web:evil.com:u:${id}`)).toBeNull();
    expect(fresh.parseUserDid(`did:web:oxy.so.evil.com:u:${id}`)).toBeNull();
    expect(fresh.parseUserDid('did:web:oxy.so:u:')).toBeNull();
    expect(fresh.parseUserDid(`did:web:oxy.so:u:${id}:extra`)).toBeNull();
  });

  it('isSelfIssuedByUser matches the caller account under either spelling and nobody else', async () => {
    process.env.DID_WEB_DOMAIN = 'api.oxy.so';
    const fresh = await loadDidServiceFresh();
    const me = '507f1f77bcf86cd799439011';
    const other = '507f1f77bcf86cd799439099';
    const sdkDid = `did:web:oxy.so:u:${me}`;
    const serverDid = `did:web:api.oxy.so:u:${me}`;

    expect(fresh.isSelfIssuedByUser({ subject: sdkDid, issuer: sdkDid }, me)).toBe(true);
    expect(fresh.isSelfIssuedByUser({ subject: serverDid, issuer: serverDid }, me)).toBe(true);

    // Another account's DID, a foreign domain, or issuer ≠ subject all fail.
    expect(fresh.isSelfIssuedByUser({ subject: sdkDid, issuer: sdkDid }, other)).toBe(false);
    expect(
      fresh.isSelfIssuedByUser({ subject: `did:web:evil.com:u:${me}`, issuer: `did:web:evil.com:u:${me}` }, me),
    ).toBe(false);
    expect(fresh.isSelfIssuedByUser({ subject: sdkDid, issuer: `did:web:oxy.so:u:${other}` }, me)).toBe(false);
  });
});

describe('buildDidDocument — personal data node (F5a)', () => {
  const publicKey = newPublicKey();
  const base = {
    _id: '507f1f77bcf86cd799439011',
    publicKey,
    username: 'nate',
    authMethods: [{ type: 'identity', metadata: { publicKey } }],
    type: 'local',
  };

  it('adds the #oxy-node service when an ACTIVE node endpoint is supplied', () => {
    const doc = buildDidDocument({ ...base, node: { endpoint: 'https://node.nate.com' } });
    const did = buildUserDid(base._id);

    expect(() => didDocumentSchema.parse(doc)).not.toThrow();
    expect(doc.service).toContainEqual({
      id: `${did}#oxy-node`,
      type: 'OxyPersonalDataNode',
      serviceEndpoint: 'https://node.nate.com',
    });
  });

  it('omits the #oxy-node service when no node is supplied', () => {
    const doc = buildDidDocument(base);
    expect(doc.service.some((s) => s.id.endsWith('#oxy-node'))).toBe(false);
  });

  it('omits the #oxy-node service when the node is null (revoked / inactive)', () => {
    const doc = buildDidDocument({ ...base, node: null });
    expect(doc.service.some((s) => s.id.endsWith('#oxy-node'))).toBe(false);
  });
});

describe('buildDidDocument — atproto BE-DISCOVERED seam (C4)', () => {
  const publicKey = newPublicKey();
  const selfSovereign = {
    _id: '507f1f77bcf86cd799439011',
    publicKey,
    username: 'nate',
    authMethods: [{ type: 'identity', metadata: { publicKey } }],
    type: 'local',
  };
  const custodial = {
    _id: '507f1f77bcf86cd799439012',
    username: 'paula',
    authMethods: [{ type: 'password', metadata: { email: 'paula@oxy.so' } }],
    type: 'local',
  };

  const ORIGINAL_BRIDGE_ENABLED = process.env.ATPROTO_BRIDGE_ENABLED;
  const ORIGINAL_PDS_ENDPOINT = process.env.ATPROTO_PDS_ENDPOINT;
  const PDS = 'https://mention.earth';

  function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  afterEach(() => {
    restoreEnv('ATPROTO_BRIDGE_ENABLED', ORIGINAL_BRIDGE_ENABLED);
    restoreEnv('ATPROTO_PDS_ENDPOINT', ORIGINAL_PDS_ENDPOINT);
  });

  function enableBridge(): void {
    process.env.ATPROTO_BRIDGE_ENABLED = 'true';
    process.env.ATPROTO_PDS_ENDPOINT = PDS;
  }

  it('adds the #atproto_pds service + a Multikey VM for a bridged self-sovereign user', () => {
    enableBridge();
    const doc = buildDidDocument(selfSovereign);
    const did = buildUserDid(selfSovereign._id);

    expect(() => didDocumentSchema.parse(doc)).not.toThrow();

    // PDS service points at the configured bridge base URL.
    expect(doc.service).toContainEqual({
      id: `${did}#atproto_pds`,
      type: 'AtprotoPersonalDataServer',
      serviceEndpoint: PDS,
    });

    // Multikey VM alongside the existing secp256k1 VM, same key, atproto form.
    const atprotoVm = doc.verificationMethod.find((vm) => vm.id === `${did}#atproto`);
    expect(atprotoVm).toBeDefined();
    expect(atprotoVm).toMatchObject({ id: `${did}#atproto`, type: 'Multikey', controller: did });
    // secp256k1 Multikeys are the `zQ3sh…` did:key form.
    expect(atprotoVm && 'publicKeyMultibase' in atprotoVm && atprotoVm.publicKeyMultibase).toMatch(/^zQ3sh/);

    // The atproto VM is referenced as an authentication + assertion method.
    expect(doc.authentication).toContain(`${did}#atproto`);
    expect(doc.assertionMethod).toContain(`${did}#atproto`);

    // The canonical secp256k1 #key-1 VM is untouched.
    expect(doc.verificationMethod).toContainEqual({
      id: `${did}#key-1`,
      type: 'EcdsaSecp256k1VerificationKey2019',
      controller: did,
      publicKeyHex: publicKey,
    });
  });

  it('leaves a self-sovereign document byte-identical when the bridge is OFF', () => {
    restoreEnv('ATPROTO_BRIDGE_ENABLED', undefined);
    restoreEnv('ATPROTO_PDS_ENDPOINT', undefined);
    const off = buildDidDocument(selfSovereign);

    expect(off.service.some((s) => s.id.endsWith('#atproto_pds'))).toBe(false);
    expect(off.verificationMethod.some((vm) => vm.type === 'Multikey')).toBe(false);
    expect(off.authentication).not.toContain(`${buildUserDid(selfSovereign._id)}#atproto`);
  });

  it('does NOT add the atproto seam to a custodial (no own key) user even when enabled', () => {
    enableBridge();
    process.env.OXY_PUBLIC_KEY = newPublicKey();
    const doc = buildDidDocument(custodial);

    expect(() => didDocumentSchema.parse(doc)).not.toThrow();
    expect(doc.service.some((s) => s.id.endsWith('#atproto_pds'))).toBe(false);
    expect(doc.verificationMethod.some((vm) => vm.type === 'Multikey')).toBe(false);
  });

  it('FAILS CLOSED when enabled but no PDS endpoint is configured', () => {
    process.env.ATPROTO_BRIDGE_ENABLED = 'true';
    delete process.env.ATPROTO_PDS_ENDPOINT;
    const doc = buildDidDocument(selfSovereign);

    expect(doc.service.some((s) => s.id.endsWith('#atproto_pds'))).toBe(false);
    expect(doc.verificationMethod.some((vm) => vm.type === 'Multikey')).toBe(false);
  });
});
