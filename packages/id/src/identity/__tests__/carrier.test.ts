/**
 * The web holder's rules (ADR 0024), with the network, the authenticator and
 * storage replaced by in-memory fakes. The crypto is the real `@oxy.so/core`
 * holder crypto, and the fake API VERIFIES every root proof the way the real one
 * does — canonical claims, one-use challenges, envelope digests, revisions — so a
 * client that signs the wrong thing fails here.
 */

import {
  deriveIdentityFromPrivateKey,
  deriveMoveKey,
  deriveMoveSasV2,
  digestIdentityPayload,
  digestMoveCiphertext,
  generateMoveEphemeralKeyPair,
  generateWebIdentity,
  openMovedIdentity,
  sealWebIdentity,
  signMoveReceiptV2,
  unlockWebIdentity,
  verifyMoveCommitment,
} from '@oxy.so/core';
import {
  IDENTITY_ERROR_CODES,
  IDENTITY_PROOF_AUDIENCE,
  buildIdentityProofMessage,
  type IdentityMoveState,
  type IdentityProof,
  type IdentityProofAction,
  type WebIdentityEnvelope,
  type WebIdentityEnvelopeResponse,
} from '@oxy.so/contracts';
import { signMessage, verifySignature } from '@oxy.so/protocol';
import type { CarrierAccount, IdentityApi } from '../api';
import {
  HolderError,
  cancelMove,
  completeMove,
  confirmPhrase,
  deleteAccount,
  establishRoot,
  openRootForDisplay,
  pickConfirmationPositions,
  readIdentityStatus,
  readMove,
  recoverSignedOut,
  resealFromMaterial,
  sendMove,
  signIn,
  signUp,
  startMove,
  withRoot,
  type CarrierPorts,
  type CarrierSession,
} from '../carrier';
import type { PrfRequest } from '../passkey';

const CREDENTIAL = 'credential-aaaaaaaaaaaaaaaa';
const NEW_CREDENTIAL = 'credential-nnnnnnnnnnnnnnnn';
const RP_ID = 'oxy.so';
const prf = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const REGISTRATION_CHALLENGE = Buffer.from(new Uint8Array(32).fill(0xab)).toString('base64url');

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

interface FakeServer {
  account: CarrierAccount;
  envelope: WebIdentityEnvelope | null;
  revision: number;
  phraseConfirmedAt: string | null;
  recoveryVerifiedAt: string | null;
  calls: string[];
  challenges: Map<string, IdentityProofAction>;
  offline?: boolean;
  deleted?: { signature: string; timestamp: number; confirmText: string };
  move?: IdentityMoveState;
  registered?: { username: string; identity: { envelope: WebIdentityEnvelope; proof: IdentityProof } };
}

let challengeCounter = 0;
function nextChallenge(): string {
  challengeCounter += 1;
  return challengeCounter.toString(16).padStart(64, '0');
}

async function checkProof(server: FakeServer, action: IdentityProofAction, root: string, proof: IdentityProof, claims: { subject: string; actor: string; payload?: unknown; expectedRevision?: number | null }) {
  if (server.challenges.get(proof.challenge) !== action) throw new HttpError(401, IDENTITY_ERROR_CODES.proofInvalid);
  server.challenges.delete(proof.challenge);
  const message = buildIdentityProofMessage({
    action,
    subject: claims.subject,
    actor: claims.actor,
    rootPublicKey: root,
    payloadDigest: claims.payload === undefined ? null : digestIdentityPayload(claims.payload),
    expectedRevision: claims.expectedRevision ?? null,
    audience: IDENTITY_PROOF_AUDIENCE,
    challenge: proof.challenge,
    expiresAt: proof.expiresAt,
  });
  if (!(await verifySignature(message, proof.signature, root))) throw new HttpError(401, IDENTITY_ERROR_CODES.proofInvalid);
}

function fakePorts(
  server: FakeServer,
  authenticator: { prf: Map<string, Uint8Array | null>; createPrf?: Uint8Array | null; answeringCredential?: string } = { prf: new Map([[CREDENTIAL, prf(7)]]) },
) {
  const local = new Map<string, WebIdentityEnvelope>();
  const ceremonies: { kind: 'assert' | 'create' | 'prf'; request?: PrfRequest }[] = [];
  const response = (): WebIdentityEnvelopeResponse => ({
    envelope: server.envelope,
    revision: server.envelope ? server.revision : 0,
    rootLinked: server.account.publicKey !== null,
    phraseConfirmedAt: server.phraseConfirmedAt,
    recoveryVerifiedAt: server.recoveryVerifiedAt,
    updatedAt: server.envelope ? '2026-09-16T00:00:00.000Z' : null,
  });
  const reachable = () => {
    if (server.offline) throw new TypeError('Failed to fetch');
  };
  const api: IdentityApi = {
    loginOptions: async () => ({ challenge: 'c', rpId: RP_ID }),
    loginVerify: async () => server.account,
    registerOptions: async () => ({ challenge: REGISTRATION_CHALLENGE, rp: { name: 'Oxy', id: RP_ID }, user: { id: 'u', name: 'n', displayName: 'n' }, pubKeyCredParams: [] }),
    registerVerify: async (_response, username, identity) => {
      server.calls.push('register');
      const root = identity.envelope.publicKey;
      server.challenges.set(Buffer.from(REGISTRATION_CHALLENGE, 'base64url').toString('hex'), 'enroll_identity');
      await checkProof(server, 'enroll_identity', root, identity.proof, { subject: `username:${username}`, actor: `credential:${NEW_CREDENTIAL}`, payload: { envelope: identity.envelope } });
      server.registered = { username, identity };
      server.account = { ...server.account, username, publicKey: root };
      server.envelope = identity.envelope;
      server.revision = 1;
      return server.account;
    },
    isUsernameAvailable: async () => true,
    proofChallenge: async (action) => {
      reachable();
      const challenge = nextChallenge();
      server.challenges.set(challenge, action);
      return { challenge, expiresAt: Date.now() + 60_000, audience: IDENTITY_PROOF_AUDIENCE };
    },
    getEnvelope: async () => {
      reachable();
      return response();
    },
    putEnvelope: async (envelope, { proof, expectedRevision }) => {
      server.calls.push('put');
      const root = server.account.publicKey as string;
      await checkProof(server, 'web_envelope_put', root, proof, { subject: server.account.userId, actor: server.account.userId, payload: envelope, expectedRevision });
      if (expectedRevision !== (server.envelope ? server.revision : 0)) throw new HttpError(409, IDENTITY_ERROR_CODES.revisionConflict);
      server.envelope = envelope;
      server.revision = expectedRevision + 1;
      return response();
    },
    establishIdentity: async (envelope, proof, assertion) => {
      server.calls.push('establish');
      if (!assertion || (assertion as { id?: string }).id !== CREDENTIAL) throw new HttpError(401, IDENTITY_ERROR_CODES.freshFactorRequired);
      if (server.account.publicKey && server.account.publicKey !== envelope.publicKey) throw new HttpError(409, IDENTITY_ERROR_CODES.rootAlreadyLinked);
      await checkProof(server, 'web_envelope_establish', envelope.publicKey, proof, { subject: server.account.userId, actor: server.account.userId, payload: envelope });
      server.account = { ...server.account, publicKey: envelope.publicKey };
      server.envelope = envelope;
      server.revision += 1;
      return response();
    },
    confirmPhrase: async ({ proof, expectedRevision }) => {
      server.calls.push('confirm');
      await checkProof(server, 'web_envelope_phrase_confirmed', server.account.publicKey as string, proof, { subject: server.account.userId, actor: server.account.userId, expectedRevision });
      server.phraseConfirmedAt = '2026-09-16T00:00:01.000Z';
      return response();
    },
    recoveryVerified: async ({ proof, expectedRevision }) => {
      server.calls.push('recovery-verified');
      await checkProof(server, 'web_envelope_recovery_verified', server.account.publicKey as string, proof, { subject: server.account.userId, actor: server.account.userId, expectedRevision });
      server.recoveryVerifiedAt = '2026-09-16T00:00:02.000Z';
      return response();
    },
    deleteEnvelope: async ({ proof, expectedRevision }) => {
      server.calls.push('delete');
      await checkProof(server, 'web_envelope_delete', server.account.publicKey as string, proof, { subject: server.account.userId, actor: server.account.userId, expectedRevision });
      server.envelope = null;
    },
    recoveryChallenge: async () => {
      const challenge = nextChallenge();
      server.challenges.set(challenge, 'recover_account_start');
      return { challenge, expiresAt: Date.now() + 60_000 };
    },
    recoveryStart: async (publicKey, proof) => {
      server.calls.push('recovery-start');
      await checkProof(server, 'recover_account_start', publicKey, proof, { subject: `root:${publicKey}`, actor: 'anonymous' });
      if (server.account.publicKey !== publicKey) throw new HttpError(404, IDENTITY_ERROR_CODES.recoveryFailed);
      server.challenges.set(Buffer.from(REGISTRATION_CHALLENGE, 'base64url').toString('hex'), 'recover_account_complete');
      return {
        ticket: 'ab'.repeat(32),
        accountId: server.account.userId,
        username: server.account.username,
        registrationOptions: { challenge: REGISTRATION_CHALLENGE, rp: { name: 'Oxy', id: RP_ID }, user: { id: 'u', name: 'n', displayName: 'n' }, pubKeyCredParams: [] },
        expiresAt: Date.now() + 60_000,
      };
    },
    recoveryComplete: async ({ envelope, proof }) => {
      server.calls.push('recovery-complete');
      await checkProof(server, 'recover_account_complete', server.account.publicKey as string, proof, { subject: server.account.userId, actor: `credential:${NEW_CREDENTIAL}`, payload: { envelope } });
      server.envelope = envelope;
      server.revision += 1;
      server.phraseConfirmedAt = 'now';
      server.recoveryVerifiedAt = 'now';
      return server.account;
    },
    createMove: async (initiatorCommitment) => {
      server.move = {
        moveId: '0123456789abcdef0123456789abcdef',
        status: 'pending',
        protocolVersion: 2,
        initiatorCommitment,
        initiatorCommitmentNonce: null,
        publicKey: server.account.publicKey as string,
        initiatorEphemeralPublicKey: null,
        responderEphemeralPublicKey: null,
        nonce: null,
        ciphertext: null,
        receiptSignature: null,
        receiptTimestamp: null,
        expiresAt: '2026-09-16T00:05:00.000Z',
      };
      return { moveId: server.move.moveId, expiresAt: server.move.expiresAt };
    },
    getMove: async () => ({ ...(server.move as IdentityMoveState) }),
    revealMove: async (_moveId, initiatorEphemeralPublicKey, commitmentNonce) => {
      server.calls.push('reveal');
      const move = server.move as IdentityMoveState;
      if (move.status !== 'joined' || move.initiatorEphemeralPublicKey !== null) throw new HttpError(409, 'CONFLICT');
      if (!verifyMoveCommitment(initiatorEphemeralPublicKey, commitmentNonce, move.initiatorCommitment as string)) throw new HttpError(400, 'BAD_REQUEST');
      server.move = { ...move, initiatorEphemeralPublicKey, initiatorCommitmentNonce: commitmentNonce };
      return { ...server.move };
    },
    sealMove: async (_moveId, body) => {
      server.calls.push('seal');
      server.move = { ...(server.move as IdentityMoveState), status: 'sealed', nonce: body.nonce, ciphertext: body.ciphertext };
      return server.move;
    },
    cancelMove: async () => {
      server.move = { ...(server.move as IdentityMoveState), status: 'cancelled', nonce: null, ciphertext: null };
    },
    approvalInfo: async () => {
      throw new Error('unused');
    },
    authorizeCode: async () => undefined,
    denyCode: async () => undefined,
    deleteAccount: async ({ signature, timestamp, confirmText }) => {
      server.deleted = { signature, timestamp, confirmText };
    },
    signOut: async () => undefined,
  };
  const ports: CarrierPorts = {
    api,
    passkeys: {
      create: async () => {
        ceremonies.push({ kind: 'create' });
        return { response: { id: NEW_CREDENTIAL }, credentialId: NEW_CREDENTIAL, rpId: RP_ID, prfOutput: authenticator.createPrf ?? null };
      },
      assert: async () => {
        ceremonies.push({ kind: 'assert' });
        return { response: { id: CREDENTIAL }, credentialId: CREDENTIAL };
      },
      evaluatePrf: async (request) => {
        ceremonies.push({ kind: 'prf', request });
        const credentialId = authenticator.answeringCredential ?? request.credentialIds[0];
        const value = authenticator.prf.get(credentialId);
        return { credentialId, prfOutput: value ? new Uint8Array(value) : null, response: { id: credentialId } };
      },
    },
    local: {
      read: async (userId) => local.get(userId) ?? null,
      write: async (userId, envelope) => void local.set(userId, envelope),
      remove: async (userId) => void local.delete(userId),
    },
  };
  return { ports, local, ceremonies };
}

const newServer = (publicKey: string | null = null): FakeServer => ({
  account: { userId: 'user-1', username: 'nate', publicKey, sessionId: 'session-1' },
  envelope: null,
  revision: 0,
  phraseConfirmedAt: null,
  recoveryVerifiedAt: null,
  calls: [],
  challenges: new Map(),
});

const sessionOf = (server: FakeServer): CarrierSession => ({ account: server.account, credentialId: CREDENTIAL, rpId: RP_ID });

function sealed(identity: ReturnType<typeof generateWebIdentity>, credentialId = CREDENTIAL, fill = 7): WebIdentityEnvelope {
  const { envelope, dataKey } = sealWebIdentity(identity, { prfOutput: prf(fill), credentialId, rpId: RP_ID }, new Date(), { version: 2 });
  dataKey.fill(0);
  return envelope;
}

describe('signing in (ADR 0024 D3)', () => {
  it('authenticates without a PRF ceremony and reads status from metadata', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    server.envelope = sealed(identity);
    server.revision = 3;
    const { ports, ceremonies } = fakePorts(server);

    const session = await signIn(ports);
    const status = await readIdentityStatus(ports, session);

    expect(ceremonies.map((c) => c.kind)).toEqual(['assert']);
    expect(session).toEqual({ account: server.account, credentialId: CREDENTIAL, rpId: RP_ID });
    expect(status).toMatchObject({ kind: 'ready', revision: 3, signedInWithHolder: true, hasPhrase: true, phraseConfirmedAt: null });
  });

  it('distinguishes a root kept elsewhere from an account with no root at all', async () => {
    const elsewhere = newServer(generateWebIdentity().publicKey);
    expect(await readIdentityStatus(fakePorts(elsewhere).ports, sessionOf(elsewhere))).toEqual({ kind: 'elsewhere' });
    const keyless = newServer();
    expect(await readIdentityStatus(fakePorts(keyless).ports, sessionOf(keyless))).toEqual({ kind: 'no-root' });
  });
});

describe('creating an account (ADR 0024 D4)', () => {
  it('creates the passkey, confirms PRF in a second ceremony under the RP ID, and registers WITH the root', async () => {
    const server = newServer();
    const { ports, ceremonies, local } = fakePorts(server, { prf: new Map([[NEW_CREDENTIAL, prf(3)]]) });

    const { session, identity } = await signUp(ports, '  nate  ');

    expect(ceremonies.map((c) => c.kind)).toEqual(['create', 'prf']);
    expect(ceremonies[1].request).toEqual({ rpId: RP_ID, credentialIds: [NEW_CREDENTIAL] });
    expect(server.registered?.username).toBe('nate');
    expect(server.account.publicKey).toBe(identity.publicKey);
    const envelope = server.envelope as WebIdentityEnvelope;
    expect(envelope.version).toBe(2);
    expect(envelope.wraps).toEqual([expect.objectContaining({ credentialId: NEW_CREDENTIAL, rpId: RP_ID, verifiedAt: expect.any(String) })]);
    expect(unlockWebIdentity(envelope, prf(3), NEW_CREDENTIAL).publicKey).toBe(identity.publicKey);
    expect(session).toMatchObject({ credentialId: NEW_CREDENTIAL, rpId: RP_ID });
    expect(local.get('user-1')).toEqual(envelope);
  });

  it('creates NO account when the authenticator gives no usable PRF output', async () => {
    const server = newServer();
    const { ports } = fakePorts(server, { prf: new Map([[NEW_CREDENTIAL, null]]) });
    await expect(signUp(ports, 'nate')).rejects.toMatchObject({ failure: 'prf-unsupported' });
    expect(server.calls).toEqual([]);
    expect(server.account.publicKey).toBeNull();
  });

  it('creates NO account when the PRF output at create() and at the follow-up disagree', async () => {
    const server = newServer();
    const { ports } = fakePorts(server, { prf: new Map([[NEW_CREDENTIAL, prf(3)]]), createPrf: prf(4) });
    await expect(signUp(ports, 'nate')).rejects.toBeInstanceOf(HolderError);
    expect(server.calls).toEqual([]);
  });

  it('retries a finalize that got no answer, and stops at an answer', async () => {
    const server = newServer();
    const { ports } = fakePorts(server, { prf: new Map([[NEW_CREDENTIAL, prf(3)]]) });
    const original = ports.api.registerVerify;
    let attempts = 0;
    ports.api.registerVerify = async (...args) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('Failed to fetch');
      return original(...args);
    };
    await signUp(ports, 'nate');
    expect(attempts).toBe(2);
  });
});

describe('root operations open the root once, and wipe it', () => {
  it('asks the envelope’s own passkeys, under their RP ID, and wipes the root after the operation', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    server.envelope = sealed(identity);
    server.revision = 1;
    const { ports, ceremonies } = fakePorts(server);
    let seen: { privateKey: string } | null = null;

    await withRoot(ports, sessionOf(server), async (opened) => {
      expect(opened.publicKey).toBe(identity.publicKey);
      seen = opened;
    });

    expect(ceremonies).toEqual([{ kind: 'prf', request: { rpId: RP_ID, credentialIds: [CREDENTIAL] } }]);
    expect(seen).toMatchObject({ privateKey: '', mnemonic: '' });
  });

  it('reports a passkey whose PRF no longer opens its wrap as locked, and writes nothing', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    server.envelope = sealed(identity);
    const { ports } = fakePorts(server, { prf: new Map([[CREDENTIAL, prf(9)]]) });
    await expect(openRootForDisplay(ports, sessionOf(server))).rejects.toMatchObject({ failure: 'locked' });
    expect(server.calls).toEqual([]);
  });

  it('never lets a stale local copy override the server: a removed web holder does not open', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    const { ports, local } = fakePorts(server);
    local.set('user-1', sealed(identity));
    await expect(openRootForDisplay(ports, sessionOf(server))).rejects.toMatchObject({ failure: 'no-web-holder' });
    expect(local.has('user-1')).toBe(false);
  });

  it('uses the local copy only when the API cannot be reached, and only for an operation that writes nothing', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    const { ports, local } = fakePorts(server);
    local.set('user-1', sealed(identity));
    server.offline = true;

    const opened = await openRootForDisplay(ports, sessionOf(server));
    expect(opened.publicKey).toBe(identity.publicKey);
    await expect(withRoot(ports, sessionOf(server), async () => undefined)).rejects.toMatchObject({ failure: 'offline' });
  });

  it('confirms the phrase with a one-use proof bound to the current revision', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    server.envelope = sealed(identity);
    server.revision = 5;
    const { ports } = fakePorts(server);

    const status = await confirmPhrase(ports, sessionOf(server), identity);
    expect(status).toMatchObject({ kind: 'ready', phraseConfirmedAt: expect.any(String) });
    expect(server.challenges.size).toBe(0);
  });
});

describe('a legacy account without a root', () => {
  it('establishes one with the SAME ceremony giving the PRF output and the fresh assertion', async () => {
    const server = newServer();
    const { ports, ceremonies } = fakePorts(server);

    const { identity, status } = await establishRoot(ports, sessionOf(server));

    expect(ceremonies).toHaveLength(1);
    expect(ceremonies[0].request).toEqual({ rpId: RP_ID, credentialIds: [CREDENTIAL], challengeHex: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(server.account.publicKey).toBe(identity.publicKey);
    expect(status).toMatchObject({ kind: 'ready', signedInWithHolder: true });
  });

  it('creates nothing where PRF is unavailable', async () => {
    const server = newServer();
    const { ports } = fakePorts(server, { prf: new Map([[CREDENTIAL, null]]) });
    await expect(establishRoot(ports, sessionOf(server))).rejects.toMatchObject({ failure: 'prf-unsupported' });
    expect(server.calls).toEqual([]);
  });
});

describe('recovery', () => {
  it('re-seals this account’s own root from its phrase, replacing the holder at the expected revision', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    server.envelope = sealed(identity, 'credential-lost-aaaaaaaaa', 1);
    server.revision = 2;
    const { ports } = fakePorts(server, { prf: new Map([[CREDENTIAL, prf(4)]]) });

    const status = await resealFromMaterial(ports, sessionOf(server), { kind: 'mnemonic', mnemonic: identity.mnemonic });

    expect(server.calls).toEqual(['put', 'recovery-verified', 'confirm']);
    expect(unlockWebIdentity(server.envelope as WebIdentityEnvelope, prf(4), CREDENTIAL).publicKey).toBe(identity.publicKey);
    expect(status).toMatchObject({ kind: 'ready', revision: 3, phraseConfirmedAt: expect.any(String), recoveryVerifiedAt: expect.any(String) });
  });

  it('refuses material that belongs to a different root, before any ceremony', async () => {
    const server = newServer(generateWebIdentity().publicKey);
    const { ports, ceremonies } = fakePorts(server);
    await expect(resealFromMaterial(ports, sessionOf(server), { kind: 'mnemonic', mnemonic: generateWebIdentity().mnemonic })).rejects.toMatchObject({ failure: 'root-mismatch' });
    expect(ceremonies).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it('recovers signed out from the phrase alone: the SAME account, a new passkey, the root sealed under it', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    const { ports, ceremonies } = fakePorts(server, { prf: new Map([[NEW_CREDENTIAL, prf(6)]]) });

    const session = await recoverSignedOut(ports, { kind: 'mnemonic', mnemonic: identity.mnemonic });

    expect(server.calls).toEqual(['recovery-start', 'recovery-complete']);
    expect(ceremonies.map((c) => c.kind)).toEqual(['create', 'prf']);
    expect(session).toMatchObject({ account: { userId: 'user-1' }, credentialId: NEW_CREDENTIAL, rpId: RP_ID });
    expect(unlockWebIdentity(server.envelope as WebIdentityEnvelope, prf(6), NEW_CREDENTIAL).publicKey).toBe(identity.publicKey);
  });

  it('recovers a raw-key root as a raw-key root', async () => {
    const identity = deriveIdentityFromPrivateKey('5e'.repeat(32));
    const server = newServer(identity.publicKey);
    const { ports } = fakePorts(server, { prf: new Map([[NEW_CREDENTIAL, prf(6)]]) });
    await recoverSignedOut(ports, { kind: 'raw-key', privateKey: '5e'.repeat(32) });
    const envelope = server.envelope as WebIdentityEnvelope;
    expect(envelope.version === 2 && envelope.secretKind).toBe('raw-private-key');
    expect(unlockWebIdentity(envelope, prf(6), NEW_CREDENTIAL).mnemonic).toBeNull();
  });

  it('creates no passkey for a root no account uses', async () => {
    const server = newServer(generateWebIdentity().publicKey);
    const { ports, ceremonies } = fakePorts(server);
    await expect(recoverSignedOut(ports, { kind: 'mnemonic', mnemonic: generateWebIdentity().mnemonic })).rejects.toMatchObject({ status: 404 });
    expect(ceremonies).toEqual([]);
  });
});

describe('account deletion', () => {
  it('signs the exact message the API verifies, with a root opened for that operation only', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    server.envelope = sealed(identity);
    const { ports, local } = fakePorts(server);
    local.set('user-1', server.envelope);

    await deleteAccount(ports, sessionOf(server), 'nate');

    const { signature, timestamp, confirmText } = server.deleted as NonNullable<FakeServer['deleted']>;
    expect(confirmText).toBe('nate');
    expect(await verifySignature(`delete:${identity.publicKey}:${timestamp}`, signature, identity.publicKey)).toBe(true);
    expect(local.has('user-1')).toBe(false);
  });
});

describe('phrase confirmation', () => {
  it('asks for three distinct positions, in order, whatever the random source does', () => {
    expect(pickConfirmationPositions(12, () => 0)).toHaveLength(3);
    const positions = pickConfirmationPositions(24, () => 0.999);
    expect(new Set(positions).size).toBe(3);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(positions.every((p) => p >= 0 && p < 24)).toBe(true);
  });
});

describe('giving the root to Commons (ADR 0024 D6, protocol version 2)', () => {
  async function readyAccount() {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    server.envelope = sealed(identity);
    server.revision = 1;
    const { ports, local } = fakePorts(server);
    const session = await signIn(ports);
    await ports.local.write('user-1', server.envelope);
    return { identity, server, ports, local, session };
  }

  /** Commons: reads the commitment, joins with its own key. */
  function join(server: FakeServer) {
    const commons = generateMoveEphemeralKeyPair();
    const commitmentSeen = (server.move as IdentityMoveState).initiatorCommitment;
    server.move = { ...(server.move as IdentityMoveState), status: 'joined', responderEphemeralPublicKey: commons.publicKey };
    return { commons, commitmentSeen };
  }

  async function deliver(keepWebHolder: boolean) {
    const context = await readyAccount();
    const { identity, server, ports, session } = context;
    const move = await startMove(ports, session);
    // Only the commitment is public until Commons joined.
    expect(server.move).toMatchObject({ protocolVersion: 2, initiatorEphemeralPublicKey: null, initiatorCommitment: move.commitment });

    const { commons, commitmentSeen } = join(server);
    const { progress } = await readMove(ports, move);
    if (progress.kind !== 'compare') throw new Error('expected compare');
    const revealed = server.move as IdentityMoveState;
    expect(server.calls).toContain('reveal');
    // Commons checks the revealed key against the commitment it read BEFORE joining, and shows the same code.
    expect(verifyMoveCommitment(revealed.initiatorEphemeralPublicKey as string, revealed.initiatorCommitmentNonce as string, commitmentSeen as string)).toBe(true);
    expect(progress.sas).toBe(
      deriveMoveSasV2({ moveId: revealed.moveId, initiatorEphemeralPublicKey: revealed.initiatorEphemeralPublicKey as string, responderEphemeralPublicKey: commons.publicKey, initiatorCommitment: commitmentSeen as string }),
    );

    await sendMove(ports, session, move, progress.sas);
    const sealedMove = server.move as IdentityMoveState;
    const payload = { nonce: sealedMove.nonce as string, ciphertext: sealedMove.ciphertext as string };
    const received = openMovedIdentity(payload, deriveMoveKey(commons.privateKey, revealed.initiatorEphemeralPublicKey as string, move.moveId), move.moveId, sealedMove.publicKey);
    expect(received.mnemonic).toBe(identity.mnemonic);
    expect(server.envelope).not.toBeNull();
    const receipt = await signMoveReceiptV2((message) => signMessage(message, received.privateKey), {
      moveId: move.moveId,
      rootPublicKey: identity.publicKey,
      initiatorEphemeralPublicKey: revealed.initiatorEphemeralPublicKey as string,
      responderEphemeralPublicKey: commons.publicKey,
      ciphertextDigest: digestMoveCiphertext(payload),
    });
    server.move = { ...sealedMove, status: 'completed', nonce: null, ciphertext: null, receiptSignature: receipt.signature, receiptTimestamp: 1 };
    const done = await readMove(ports, move);
    await completeMove(ports, session, move, done.state, { keepWebHolder });
    return { ...context, move, commons, payload };
  }

  it('ADDS Commons and keeps this browser as a holder', async () => {
    const { server, local, move } = await deliver(true);
    expect(server.envelope).not.toBeNull();
    expect(server.calls).not.toContain('delete');
    expect(local.get('user-1')).toBeDefined();
    expect(move.ephemeral.privateKey).toBe('');
    expect(move.commitmentNonce).toBe('');
  });

  it('removes the browser holder only when asked, and only after the receipt verified', async () => {
    const { server, local } = await deliver(false);
    expect(server.calls).toContain('delete');
    expect(server.envelope).toBeNull();
    expect(local.get('user-1')).toBeUndefined();
  });

  async function upToSent() {
    const context = await readyAccount();
    const move = await startMove(context.ports, context.session);
    const { commons } = join(context.server);
    const { progress } = await readMove(context.ports, move);
    if (progress.kind !== 'compare') throw new Error('expected compare');
    await sendMove(context.ports, context.session, move, progress.sas);
    return { ...context, move, commons };
  }

  it('keeps everything when the relay claims completion with a receipt that is not the root’s', async () => {
    const { server, ports, local, session, move, commons } = await upToSent();
    const sealedMove = server.move as IdentityMoveState;
    const forged = await signMoveReceiptV2((message) => signMessage(message, generateWebIdentity().privateKey), {
      moveId: move.moveId,
      rootPublicKey: sealedMove.publicKey,
      initiatorEphemeralPublicKey: move.ephemeral.publicKey,
      responderEphemeralPublicKey: commons.publicKey,
      ciphertextDigest: move.ciphertextDigest as string,
    });
    server.move = { ...sealedMove, status: 'completed', receiptSignature: forged.signature, receiptTimestamp: 1 };
    await expect(completeMove(ports, session, move, await ports.api.getMove(move.moveId), { keepWebHolder: false })).rejects.toThrow('did not prove');
    expect(server.envelope).not.toBeNull();
    expect(local.get('user-1')).toBeDefined();
  });

  it('keeps everything when the root’s receipt covers different ciphertext than this browser sealed', async () => {
    const { identity, server, ports, session, move, commons } = await upToSent();
    const sealedMove = server.move as IdentityMoveState;
    const receipt = await signMoveReceiptV2((message) => signMessage(message, identity.privateKey), {
      moveId: move.moveId,
      rootPublicKey: identity.publicKey,
      initiatorEphemeralPublicKey: move.ephemeral.publicKey,
      responderEphemeralPublicKey: commons.publicKey,
      ciphertextDigest: 'ab'.repeat(32),
    });
    server.move = { ...sealedMove, status: 'completed', receiptSignature: receipt.signature, receiptTimestamp: 1 };
    await expect(completeMove(ports, session, move, await ports.api.getMove(move.moveId), { keepWebHolder: false })).rejects.toThrow('did not prove');
    expect(server.calls).not.toContain('delete');
  });

  it('seals nothing when the joined key changed after the codes were compared', async () => {
    const { server, ports, session } = await readyAccount();
    const move = await startMove(ports, session);
    join(server);
    const { progress } = await readMove(ports, move);
    if (progress.kind !== 'compare') throw new Error('expected compare');
    server.move = { ...(server.move as IdentityMoveState), responderEphemeralPublicKey: generateMoveEphemeralKeyPair().publicKey };
    await expect(sendMove(ports, session, move, progress.sas)).rejects.toThrow('code changed');
    expect(server.calls).not.toContain('seal');
  });

  it('refuses a relay that reports another commitment or another initiator key', async () => {
    const { server, ports, session } = await readyAccount();
    const move = await startMove(ports, session);
    server.move = { ...(server.move as IdentityMoveState), initiatorCommitment: 'ab'.repeat(32) };
    await expect(readMove(ports, move)).rejects.toThrow('could not be verified');
    server.move = { ...(server.move as IdentityMoveState), initiatorCommitment: move.commitment, initiatorEphemeralPublicKey: generateMoveEphemeralKeyPair().publicKey };
    await expect(readMove(ports, move)).rejects.toThrow('could not be verified');
  });

  it('never reveals its key before Commons joined', async () => {
    const { server, ports, session } = await readyAccount();
    const move = await startMove(ports, session);
    expect((await readMove(ports, move)).progress).toEqual({ kind: 'waiting' });
    expect(server.calls).not.toContain('reveal');
  });

  it('cannot start without a root this passkey opens', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    server.envelope = sealed(identity, CREDENTIAL, 1);
    const { ports } = fakePorts(server);
    await expect(startMove(ports, await signIn(ports))).rejects.toMatchObject({ failure: 'locked' });
    expect(server.move).toBeUndefined();
  });

  it('reports a cancelled transfer as ended and wipes the ephemeral key', async () => {
    const { ports, session } = await readyAccount();
    const move = await startMove(ports, session);
    const copy = { ...move, ephemeral: { ...move.ephemeral } };
    await cancelMove(ports, move);
    expect((await readMove(ports, copy)).progress).toEqual({ kind: 'ended', reason: 'cancelled' });
    expect(move.ephemeral.privateKey).toBe('');
  });
});
