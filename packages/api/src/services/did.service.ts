/**
 * DID Document Service (self-sovereign identity layer — B2)
 *
 * Derives a W3C DID document for an Oxy user ON DEMAND — there is no stored DID
 * document. The DID is anchored on the stable account id (`did:web:<domain>:u:<userId>`),
 * NOT on the keypair: the keypair is a *verification method* that maps 1:1 to
 * the existing `authMethods[]`. A password-only (custodial) account gets a DID
 * controlled solely by Oxy; creating a Commons key upgrades the account to
 * self-sovereign (`controller = [userDid, OXY_DID]`); the change is fully
 * reversible by linking/unlinking the identity auth method.
 *
 * The output is validated against `didDocumentSchema` from `@oxy.so/contracts` so
 * the API can never serve a document that drifts from the published contract.
 *
 * Pure and platform-agnostic: every input is passed in (no DB access here) so
 * the function can be unit-tested with plain objects and reused by the model
 * virtual, the `GET /u/:userId/did.json` route, the auth-methods route, and the
 * signed data export.
 */

import { getNormalizedUserHandle } from '@oxy.so/core';
import {
  didDocumentSchema,
  type DidDocument,
  type SignedRecordEnvelope,
  type VerificationMethod,
  type DidService,
} from '@oxy.so/contracts';
import { OXY_NODE_SERVICE_TYPE, OXY_NODE_SERVICE_FRAGMENT } from '../utils/nodes.constants';
import {
  ATPROTO_BRIDGE_ENABLED,
  ATPROTO_PDS_ENDPOINT_ENV,
  ATPROTO_PDS_SERVICE_FRAGMENT,
  ATPROTO_PDS_SERVICE_TYPE,
  ATPROTO_VERIFICATION_METHOD_FRAGMENT,
  ATPROTO_MULTIKEY_VM_TYPE,
} from '../utils/atproto.constants';
import { secp256k1PublicKeyToMultikey } from '../utils/multikey';
import { logger } from '../utils/logger';

/**
 * The federation/identity domain — drives webfinger handles, profile URLs, and
 * the published service endpoints. MUST remain the federation apex (`oxy.so`):
 * webfinger, nodeinfo, and ActivityPub all depend on it. Kept deliberately
 * separate from where the DID document is anchored (see `DID_DOMAIN`).
 */
const FEDERATION_DOMAIN = process.env.FEDERATION_DOMAIN || 'oxy.so';

/**
 * The domain that anchors the `did:web:` identifier strings (the DID `id`,
 * controllers, verification-method ids, and service ids). Defaults to the
 * federation domain, but can be pointed independently at `api.oxy.so` via
 * `DID_WEB_DOMAIN` so the DID document is served directly by the API that owns
 * it — zero apex / CF-proxy indirection — WITHOUT moving webfinger/AP off the
 * federation apex. `did:web` method-specific ids encode any `:` as `%3A`
 * (e.g. a `host:port` dev domain); a bare apex has none.
 */
const DID_DOMAIN = (process.env.DID_WEB_DOMAIN || FEDERATION_DOMAIN).replace(/:/g, '%3A');

/** The Oxy organisation DID (controller of custodial accounts). */
export const OXY_DID = `did:web:${DID_DOMAIN}`;

/** W3C DID core + secp256k1 verification-suite contexts. */
const DID_CONTEXT = [
  'https://www.w3.org/ns/did/v1',
  'https://w3id.org/security/suites/secp256k1-2019/v1',
];

const SECP256K1_VM_TYPE = 'EcdsaSecp256k1VerificationKey2019' as const;

/**
 * The HTTPS base URL of the atproto bridge PDS, or `null` when the seam is not
 * fully configured. The seam is live ONLY when the bridge is enabled
 * (`ATPROTO_BRIDGE_ENABLED`) AND a real endpoint is set — a PDS service entry
 * with no endpoint is worse than none, so it FAILS CLOSED. Both inputs are read
 * at call time (not module load) so a test or a hot-reconfigured task observes
 * the current env. {@link ATPROTO_BRIDGE_ENABLED} is the canonical exported gate;
 * it is re-derived here from the same env var so the check stays call-time-exact.
 */
function atprotoPdsEndpoint(): string | null {
  const enabled = ATPROTO_BRIDGE_ENABLED || process.env.ATPROTO_BRIDGE_ENABLED === 'true';
  if (!enabled) {
    return null;
  }
  const endpoint = process.env[ATPROTO_PDS_ENDPOINT_ENV]?.trim();
  return endpoint && endpoint.length > 0 ? endpoint : null;
}

/**
 * The minimal identity-bearing shape of a user the DID builder reads. Accepts a
 * lean Mongoose document or any structurally-compatible object.
 */
export interface DidUserInput {
  _id: string | { toString(): string };
  publicKey?: string | null;
  username?: string | null;
  authMethods?: Array<{ type?: string | null; metadata?: { publicKey?: string | null } | null } | null> | null;
  verifiedDomains?: Array<{ domain?: string | null } | null> | null;
  type?: string | null;
  federation?: { domain?: string | null } | null;
  /**
   * F5a: the user's ACTIVE personal data node, when one is registered. Supplied
   * by the caller (which reads the `UserNode` cache — an Oxy-DB read, never the
   * node itself), so this builder stays pure. When present its `endpoint` is
   * announced as an `OxyPersonalDataNode` service entry; absent/null → omitted.
   */
  node?: { endpoint?: string | null } | null;
}

function stringifyId(id: string | { toString(): string }): string {
  return typeof id === 'string' ? id : id.toString();
}

/** Build the canonical user DID from the stable account id. */
export function buildUserDid(userId: string): string {
  return `did:web:${DID_DOMAIN}:u:${userId}`;
}

/**
 * The canonical identity apex — the domain the shipped SDK hardcodes into every
 * CLIENT-signed user DID (`@oxy.so/core` `OXY_IDENTITY_APEX`, i.e. the federation
 * apex). When `DID_WEB_DOMAIN` re-anchors the EMITTED `did:web` ids at the API
 * host for zero-proxy web resolution (prod: `api.oxy.so`), client envelopes keep
 * arriving spelled at this apex — both spellings name the SAME account namespace
 * owned by this server, so parsing accepts both.
 */
const CANONICAL_IDENTITY_APEX = FEDERATION_DOMAIN.replace(/:/g, '%3A');

/**
 * Every `did:web:…:u:` prefix this server accepts as one of ITS OWN user DIDs:
 * the emitted anchor (`DID_DOMAIN`) plus the canonical identity apex the SDK
 * signs with. Collapses to a single prefix when `DID_WEB_DOMAIN` is unset.
 */
const USER_DID_PREFIXES: readonly string[] = [
  ...new Set([`did:web:${DID_DOMAIN}:u:`, `did:web:${CANONICAL_IDENTITY_APEX}:u:`]),
];

/**
 * Parse the stable account id out of a user DID (`did:web:<domain>:u:<userId>`).
 * Accepts EITHER of this server's own anchors (see {@link USER_DID_PREFIXES}) —
 * identity comparisons must happen in ACCOUNT-id space, never by DID string
 * equality, or client-signed envelopes (SDK apex) stop matching server-derived
 * DIDs whenever `DID_WEB_DOMAIN` re-anchors web resolution. Returns the
 * `<userId>` segment, or `null` when the input is not a well-formed user DID for
 * this issuer. The caller still validates the id (e.g. `isValidObjectId`).
 */
export function parseUserDid(did: string): string | null {
  for (const prefix of USER_DID_PREFIXES) {
    if (!did.startsWith(prefix)) {
      continue;
    }
    const userId = did.slice(prefix.length);
    // A user DID has exactly one id segment after `:u:` (no further `:`).
    if (userId.length === 0 || userId.includes(':')) {
      return null;
    }
    return userId;
  }
  return null;
}

/**
 * True when `envelope` is SELF-ISSUED by the given account: its `subject`
 * resolves to `userId` under one of this server's accepted anchors AND its
 * `issuer` is exactly its `subject` (the same self-issuance equality the
 * protocol engine's authorization branch applies). This is the ONE gate every
 * self-issued civic/identity write goes through — account-based, so the SDK's
 * `did:web:oxy.so` spelling and the server's `DID_WEB_DOMAIN` spelling both
 * pass for the caller's OWN account and nobody else's.
 */
export function isSelfIssuedByUser(
  envelope: Pick<SignedRecordEnvelope, 'subject' | 'issuer'>,
  userId: string,
): boolean {
  return parseUserDid(envelope.subject) === userId && envelope.issuer === envelope.subject;
}

/**
 * Collect the distinct secp256k1 identity public keys for an account: the
 * primary `publicKey` first, then any `identity` auth-method keys not already
 * present. The ordering makes `#key-1` deterministically the primary key.
 */
function collectIdentityKeys(user: DidUserInput): string[] {
  const keys: string[] = [];
  if (user.publicKey) {
    keys.push(user.publicKey);
  }
  for (const method of user.authMethods ?? []) {
    const key = method?.type === 'identity' ? method.metadata?.publicKey : undefined;
    if (key && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

function oxyCustodialVerificationMethod(): VerificationMethod | null {
  const oxyPublicKey = process.env.OXY_PUBLIC_KEY;
  if (!oxyPublicKey) {
    return null;
  }
  return {
    id: `${OXY_DID}#oxy-custodial-key`,
    type: SECP256K1_VM_TYPE,
    controller: OXY_DID,
    publicKeyHex: oxyPublicKey,
  };
}

/**
 * Derive the W3C DID document for `user`. Self-sovereign accounts (≥1 identity
 * verification method) are controlled by `[userDid, OXY_DID]` and expose their
 * own keys; custodial accounts are controlled by `[OXY_DID]` and reference the
 * Oxy custodial key (when configured).
 */
export function buildDidDocument(user: DidUserInput): DidDocument {
  const userId = stringifyId(user._id);
  const did = buildUserDid(userId);

  const identityKeys = collectIdentityKeys(user);
  const isSelfSovereign = identityKeys.length > 0;

  const verificationMethod: VerificationMethod[] = [];
  const activeVerificationMethodIds: string[] = [];

  if (isSelfSovereign) {
    identityKeys.forEach((publicKeyHex, index) => {
      const id = `${did}#key-${index + 1}`;
      verificationMethod.push({ id, type: SECP256K1_VM_TYPE, controller: did, publicKeyHex });
      activeVerificationMethodIds.push(id);
    });
  } else {
    const custodial = oxyCustodialVerificationMethod();
    if (custodial) {
      verificationMethod.push(custodial);
      activeVerificationMethodIds.push(custodial.id);
    }
  }

  const controller = isSelfSovereign ? [did, OXY_DID] : [OXY_DID];

  const alsoKnownAs: string[] = [];
  const handle = getNormalizedUserHandle({
    username: user.username ?? undefined,
    type: user.type ?? undefined,
    federation: user.federation ?? undefined,
  });
  if (handle) {
    alsoKnownAs.push(`acct:${handle}@${FEDERATION_DOMAIN}`);
    alsoKnownAs.push(`https://${FEDERATION_DOMAIN}/@${handle}`);
  }
  for (const verified of user.verifiedDomains ?? []) {
    if (verified?.domain) {
      alsoKnownAs.push(`https://${verified.domain}`);
    }
  }

  const service: DidService[] = [
    { id: `${did}#oxy-api`, type: 'OxyApiService', serviceEndpoint: `https://api.${FEDERATION_DOMAIN}` },
  ];
  if (handle) {
    service.push({
      id: `${did}#profile`,
      type: 'OxyProfileService',
      serviceEndpoint: `https://${FEDERATION_DOMAIN}/@${handle}`,
    });
  }
  // F5a: announce the user's personal data node so a resolver can discover where
  // their self-authored records live. Derived on demand from the supplied active
  // UserNode; never stored in the document.
  if (user.node?.endpoint) {
    service.push({
      id: `${did}${OXY_NODE_SERVICE_FRAGMENT}`,
      type: OXY_NODE_SERVICE_TYPE,
      serviceEndpoint: user.node.endpoint,
    });
  }

  // C4 atproto BE-DISCOVERED seam: when the bridge is enabled and a self-sovereign
  // account holds an own identity key, additively announce the bridge PDS service
  // and an atproto `Multikey` verification method (the same secp256k1 key, encoded
  // the way a Bluesky AppView expects). Custodial accounts have no own key, so
  // they never gain an atproto VM. Derived on demand; the document stays
  // byte-identical for everyone when the seam is off.
  const pdsEndpoint = atprotoPdsEndpoint();
  if (pdsEndpoint && isSelfSovereign) {
    const atprotoVmId = `${did}${ATPROTO_VERIFICATION_METHOD_FRAGMENT}`;
    try {
      // The primary identity key is the atproto signing key (matches `#key-1`).
      const publicKeyMultibase = secp256k1PublicKeyToMultikey(identityKeys[0]);
      verificationMethod.push({
        id: atprotoVmId,
        type: ATPROTO_MULTIKEY_VM_TYPE,
        controller: did,
        publicKeyMultibase,
      });
      activeVerificationMethodIds.push(atprotoVmId);
      service.push({
        id: `${did}${ATPROTO_PDS_SERVICE_FRAGMENT}`,
        type: ATPROTO_PDS_SERVICE_TYPE,
        serviceEndpoint: pdsEndpoint,
      });
    } catch (err) {
      // A malformed stored key must never break the canonical document: skip the
      // atproto seam for this user and serve the standard document.
      logger.warn('Skipping atproto DID seam: identity key is not a valid secp256k1 public key', {
        component: 'did',
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const document: DidDocument = {
    '@context': DID_CONTEXT,
    id: did,
    controller,
    verificationMethod,
    authentication: activeVerificationMethodIds,
    assertionMethod: activeVerificationMethodIds,
    alsoKnownAs,
    service,
  };

  return didDocumentSchema.parse(document);
}

/**
 * Derive the Oxy organisation DID document served at
 * `GET /.well-known/did.json`. References the Oxy custodial key when configured.
 */
export function buildOxyDidDocument(): DidDocument {
  const custodial = oxyCustodialVerificationMethod();
  const verificationMethod = custodial ? [custodial] : [];
  const activeVerificationMethodIds = custodial ? [custodial.id] : [];

  const document: DidDocument = {
    '@context': DID_CONTEXT,
    id: OXY_DID,
    controller: [OXY_DID],
    verificationMethod,
    authentication: activeVerificationMethodIds,
    assertionMethod: activeVerificationMethodIds,
    alsoKnownAs: [`https://${FEDERATION_DOMAIN}`],
    service: [
      { id: `${OXY_DID}#oxy-api`, type: 'OxyApiService', serviceEndpoint: `https://api.${FEDERATION_DOMAIN}` },
    ],
  };

  return didDocumentSchema.parse(document);
}
