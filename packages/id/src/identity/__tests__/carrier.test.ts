/**
 * The web carrier's rules, with the network, the authenticator and storage
 * replaced by in-memory fakes. The crypto is the real `@oxy.so/core` carrier.
 */

import {
  deriveIdentityFromMnemonic,
  deriveMoveKey,
  generateMoveEphemeralKeyPair,
  generateWebIdentity,
  IDENTITY_MOVE_ACTIONS,
  openMovedIdentity,
  sealWebIdentity,
  signMoveAction,
  unlockWebIdentity,
  type OpenedWebIdentity,
} from '@oxy.so/core';
import type { IdentityMoveState, WebIdentityEnvelope, WebIdentityEnvelopeProof, WebIdentityEnvelopeResponse } from '@oxy.so/contracts';
import type { CarrierAccount, IdentityApi } from '../api';
import {
  cancelMove,
  completeMove,
  deleteAccount,
  ensureIdentity,
  pickConfirmationPositions,
  readMove,
  recoverWithPhrase,
  sendMove,
  signIn,
  signUp,
  startMove,
  unlockIdentity,
  type CarrierPorts,
  type CarrierSession,
} from '../carrier';

const CREDENTIAL = 'credential-aaaaaaaaaaaaaaaa';
const prf = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

interface FakeServer {
  account: CarrierAccount;
  envelope: WebIdentityEnvelope | null;
  phraseConfirmedAt: string | null;
  calls: string[];
  failGet?: boolean;
  deleted?: { signature: string; timestamp: number; confirmText: string };
  move?: IdentityMoveState;
}

function fakePorts(server: FakeServer, ceremony: { prfOutput: Uint8Array | null; createPrf?: Uint8Array | null } = { prfOutput: prf(7) }) {
  const local = new Map<string, WebIdentityEnvelope>();
  const response = (): WebIdentityEnvelopeResponse => ({
    envelope: server.envelope,
    phraseConfirmedAt: server.phraseConfirmedAt,
    updatedAt: server.envelope ? '2026-09-16T00:00:00.000Z' : null,
  });
  const api: IdentityApi = {
    loginOptions: async () => ({ challenge: 'c' }),
    loginVerify: async () => server.account,
    registerOptions: async () => ({ challenge: 'c', rp: { name: 'Oxy' }, user: { id: 'u', name: 'n', displayName: 'n' }, pubKeyCredParams: [] }),
    registerVerify: async () => server.account,
    isUsernameAvailable: async () => true,
    getEnvelope: async () => {
      if (server.failGet) throw new Error('offline');
      return response();
    },
    putEnvelope: async (envelope) => {
      server.calls.push('put');
      if (!server.account.publicKey || envelope.publicKey !== server.account.publicKey) throw new Error('refused');
      server.envelope = envelope;
      return response();
    },
    establishIdentity: async (envelope, _link: WebIdentityEnvelopeProof) => {
      server.calls.push('establish');
      if (server.account.publicKey && server.account.publicKey !== envelope.publicKey) throw new Error('conflict');
      server.account = { ...server.account, publicKey: envelope.publicKey };
      server.envelope = envelope;
      return response();
    },
    confirmPhrase: async () => {
      server.calls.push('confirm');
      server.phraseConfirmedAt = '2026-09-16T00:00:01.000Z';
      return response();
    },
    deleteEnvelope: async () => {
      server.calls.push('delete');
      server.envelope = null;
    },
    createMove: async (initiatorEphemeralPublicKey) => {
      server.move = {
        moveId: '0123456789abcdef0123456789abcdef',
        status: 'pending',
        publicKey: server.account.publicKey as string,
        initiatorEphemeralPublicKey,
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
      create: async () => ({ response: {}, credentialId: CREDENTIAL, prfOutput: ceremony.createPrf ?? null }),
      assert: async () => ({ response: {}, credentialId: CREDENTIAL, prfOutput: ceremony.prfOutput }),
      evaluatePrf: async () => ceremony.prfOutput,
    },
    local: {
      read: async (userId) => local.get(userId) ?? null,
      write: async (userId, envelope) => void local.set(userId, envelope),
      remove: async (userId) => void local.delete(userId),
    },
  };
  return { ports, local };
}

const newServer = (publicKey: string | null = null): FakeServer => ({
  account: { userId: 'user-1', username: 'nate', publicKey, sessionId: 'session-1' },
  envelope: null,
  phraseConfirmedAt: null,
  calls: [],
});

describe('a new or legacy account without an identity', () => {
  it('gets exactly one identity, established atomically and sealed under this passkey', async () => {
    const server = newServer();
    const { ports, local } = fakePorts(server);
    const session = await signIn(ports);

    const state = await ensureIdentity(ports, session);

    expect(state.kind).toBe('created');
    if (state.kind !== 'created') return;
    expect(server.calls).toEqual(['establish']);
    expect(server.account.publicKey).toBe(state.identity.publicKey);
    expect(unlockWebIdentity(server.envelope as WebIdentityEnvelope, prf(7), CREDENTIAL).publicKey).toBe(state.identity.publicKey);
    expect(local.get('user-1')).toEqual(server.envelope);
  });

  it('recovers the PRF output with a second local ceremony when create() returned none', async () => {
    const server = newServer();
    const { ports } = fakePorts(server, { prfOutput: prf(3), createPrf: null });
    const session = await signUp(ports, 'nate');
    expect(session.prfOutput).toEqual(prf(3));
  });

  it('keeps going WITHOUT an identity where PRF is unavailable (D3) — nothing is created', async () => {
    const server = newServer();
    const { ports } = fakePorts(server, { prfOutput: null });
    const state = await ensureIdentity(ports, await signIn(ports));
    expect(state).toEqual({ kind: 'unsupported' });
    expect(server.calls).toEqual([]);
    expect(server.account.publicKey).toBeNull();
  });
});

describe('an account that already has an identity', () => {
  it('is never given a second one when its identity lives elsewhere (Commons)', async () => {
    const server = newServer(generateWebIdentity().publicKey);
    const { ports } = fakePorts(server);
    const state = await ensureIdentity(ports, await signIn(ports));
    expect(state).toEqual({ kind: 'elsewhere' });
    expect(server.calls).toEqual([]);
  });

  it('reports ready when this passkey opens the web envelope', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    server.envelope = sealWebIdentity(identity, { prfOutput: prf(7), credentialId: CREDENTIAL }).envelope;
    const { ports } = fakePorts(server);
    const state = await ensureIdentity(ports, await signIn(ports));
    expect(state.kind).toBe('ready');
  });

  it('reports locked — and overwrites nothing — when this passkey returns a different PRF value', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    const original = sealWebIdentity(identity, { prfOutput: prf(7), credentialId: CREDENTIAL }).envelope;
    server.envelope = original;
    const { ports } = fakePorts(server, { prfOutput: prf(9) });

    const state = await ensureIdentity(ports, await signIn(ports));

    expect(state).toEqual({ kind: 'locked', failure: 'prf-mismatch' });
    expect(server.envelope).toBe(original);
    expect(server.calls).toEqual([]);
  });
});

describe('unlocking', () => {
  it('prefers the server copy: an identity moved away stops opening from a stale local copy', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    const envelope = sealWebIdentity(identity, { prfOutput: prf(7), credentialId: CREDENTIAL }).envelope;
    const { ports, local } = fakePorts(server);
    local.set('user-1', envelope);
    const session: CarrierSession = { account: server.account, credentialId: CREDENTIAL, prfOutput: prf(7) };

    await expect(unlockIdentity(ports, session)).rejects.toThrow('no identity');
    expect(local.has('user-1')).toBe(false);
  });

  it('falls back to the local copy only when the server cannot be reached', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    const { ports, local } = fakePorts(server);
    local.set('user-1', sealWebIdentity(identity, { prfOutput: prf(7), credentialId: CREDENTIAL }).envelope);
    server.failGet = true;
    const session: CarrierSession = { account: server.account, credentialId: CREDENTIAL, prfOutput: prf(7) };

    expect((await unlockIdentity(ports, session)).publicKey).toBe(identity.publicKey);
  });
});

describe('recovering with the phrase', () => {
  const session = (server: FakeServer, fill = 4): CarrierSession => ({ account: server.account, credentialId: CREDENTIAL, prfOutput: prf(fill) });

  it('re-seals the account’s own identity under the passkey just used and marks the phrase saved', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    const { ports } = fakePorts(server);

    await recoverWithPhrase(ports, session(server), deriveIdentityFromMnemonic(identity.mnemonic));

    expect(server.calls).toEqual(['put', 'confirm']);
    expect(unlockWebIdentity(server.envelope as WebIdentityEnvelope, prf(4), CREDENTIAL).publicKey).toBe(identity.publicKey);
  });

  it('refuses a phrase that belongs to a different identity', async () => {
    const server = newServer(generateWebIdentity().publicKey);
    const { ports } = fakePorts(server);
    await expect(recoverWithPhrase(ports, session(server), generateWebIdentity())).rejects.toThrow('different identity');
    expect(server.calls).toEqual([]);
  });

  it('establishes (never a bare link) for an account that has no identity yet', async () => {
    const server = newServer();
    const { ports } = fakePorts(server);
    await recoverWithPhrase(ports, session(server), generateWebIdentity());
    expect(server.calls).toEqual(['establish', 'confirm']);
  });
});

describe('account deletion', () => {
  it('signs the exact message the API verifies', async () => {
    const { verifySignature } = await import('@oxy.so/protocol');
    const identity: OpenedWebIdentity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    const { ports } = fakePorts(server);

    await deleteAccount(ports, identity, 'nate');

    const { signature, timestamp, confirmText } = server.deleted as NonNullable<FakeServer['deleted']>;
    expect(confirmText).toBe('nate');
    expect(await verifySignature(`delete:${identity.publicKey}:${timestamp}`, signature, identity.publicKey)).toBe(true);
  });
});

describe('phrase confirmation', () => {
  it('asks for three distinct positions, in order, whatever the random source does', () => {
    expect(pickConfirmationPositions(12, () => 0)).toHaveLength(3);
    const positions = pickConfirmationPositions(12, () => 0.999);
    expect(new Set(positions).size).toBe(3);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(positions.every((p) => p >= 0 && p < 12)).toBe(true);
  });
});

describe('moving the identity to Commons', () => {
  /** A web account whose identity this passkey opens. */
  async function readyAccount() {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    server.envelope = sealWebIdentity(identity, { prfOutput: prf(7), credentialId: CREDENTIAL }).envelope;
    const { ports, local } = fakePorts(server);
    const session = await signIn(ports);
    await ports.local.write('user-1', server.envelope);
    return { identity, server, ports, local, session };
  }

  /** Commons joining with its own ephemeral key. */
  function join(server: FakeServer) {
    const commons = generateMoveEphemeralKeyPair();
    server.move = { ...(server.move as IdentityMoveState), status: 'joined', responderEphemeralPublicKey: commons.publicKey };
    return commons;
  }

  it('hands the identity to the device that joined and forgets it only after a valid receipt', async () => {
    const { identity, server, ports, local, session } = await readyAccount();
    const move = await startMove(ports, session);
    expect((await readMove(ports, move)).progress).toEqual({ kind: 'waiting' });

    const commons = join(server);
    const { progress } = await readMove(ports, move);
    expect(progress.kind).toBe('compare');
    if (progress.kind !== 'compare') return;

    await sendMove(ports, session, move, progress.sas);
    const sealed = server.move as IdentityMoveState;
    const received = openMovedIdentity(
      { nonce: sealed.nonce as string, ciphertext: sealed.ciphertext as string },
      deriveMoveKey(commons.privateKey, move.ephemeral.publicKey, move.moveId),
      move.moveId,
      sealed.publicKey,
    );
    expect(received.mnemonic).toBe(identity.mnemonic);
    // Sent is not moved: the web copy stays until Commons proves it holds the key.
    expect(server.envelope).not.toBeNull();

    const receipt = await signMoveAction(received, IDENTITY_MOVE_ACTIONS.received, move.moveId);
    server.move = { ...sealed, status: 'completed', nonce: null, ciphertext: null, receiptSignature: receipt.signature, receiptTimestamp: receipt.timestamp };
    const done = await readMove(ports, move);
    expect(done.progress).toEqual({ kind: 'received' });
    await completeMove(ports, session, move, done.state);

    expect(server.envelope).toBeNull();
    expect(local.get('user-1')).toBeUndefined();
    expect(move.ephemeral.privateKey).toBe('');
  });

  it('keeps the identity when the relay claims completion without a real receipt', async () => {
    const { server, ports, local, session } = await readyAccount();
    const move = await startMove(ports, session);
    const commons = join(server);
    const { progress } = await readMove(ports, move);
    if (progress.kind !== 'compare') throw new Error('expected compare');
    await sendMove(ports, session, move, progress.sas);

    const forged = await signMoveAction(generateWebIdentity(), IDENTITY_MOVE_ACTIONS.received, move.moveId);
    server.move = { ...(server.move as IdentityMoveState), status: 'completed', receiptSignature: forged.signature, receiptTimestamp: forged.timestamp };
    await expect(completeMove(ports, session, move, await ports.api.getMove(move.moveId))).rejects.toThrow('did not prove');
    expect(server.envelope).not.toBeNull();
    expect(local.get('user-1')).toBeDefined();
    expect(commons.publicKey).toBeTruthy();
  });

  it('seals nothing when the joined key changed after the codes were compared', async () => {
    const { server, ports, session } = await readyAccount();
    const move = await startMove(ports, session);
    join(server);
    const { progress } = await readMove(ports, move);
    if (progress.kind !== 'compare') throw new Error('expected compare');

    join(server); // a different device key swapped in
    await expect(sendMove(ports, session, move, progress.sas)).rejects.toThrow('code changed');
    expect(server.calls).not.toContain('seal');
  });

  it('refuses a relay that reports someone else’s initiator key', async () => {
    const { server, ports, session } = await readyAccount();
    const move = await startMove(ports, session);
    server.move = { ...(server.move as IdentityMoveState), initiatorEphemeralPublicKey: generateMoveEphemeralKeyPair().publicKey };
    await expect(readMove(ports, move)).rejects.toThrow('could not be verified');
  });

  it('cannot start without an identity this passkey opens', async () => {
    const identity = generateWebIdentity();
    const server = newServer(identity.publicKey);
    server.envelope = sealWebIdentity(identity, { prfOutput: prf(1), credentialId: CREDENTIAL }).envelope;
    const { ports } = fakePorts(server);
    await expect(startMove(ports, await signIn(ports))).rejects.toThrow();
    expect(server.move).toBeUndefined();
  });

  it('reports a cancelled move as ended and wipes the ephemeral key', async () => {
    const { ports, session } = await readyAccount();
    const move = await startMove(ports, session);
    await cancelMove(ports, move);
    expect((await readMove(ports, { ...move, ephemeral: { ...move.ephemeral } })).progress).toEqual({ kind: 'ended', reason: 'cancelled' });
    expect(move.ephemeral.privateKey).toBe('');
  });
});
