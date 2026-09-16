import {
  createMoveCommitment,
  deriveMoveKey,
  deriveMoveSas,
  deriveMoveSasV2,
  digestMoveCiphertext,
  verifyMoveReceiptV2,
  generateMoveEphemeralKeyPair,
  generateWebIdentity,
  sealIdentityForMove,
  verifyMoveReceipt,
} from '@oxy.so/core';
import type { IdentityMoveState } from '@oxy.so/contracts';
import { signMessage } from '@oxy.so/protocol';
import { awaitCode, confirmReceived, forgetMove, joinMove, receiveIdentity, type MoveRelay } from '@/lib/identity-move/receiveMove';

const MOVE_ID = '0123456789abcdef0123456789abcdef';

/** The web side and an in-memory relay that behaves like the API. */
function setup() {
  const identity = generateWebIdentity();
  const web = generateMoveEphemeralKeyPair();
  let state: IdentityMoveState = {
    moveId: MOVE_ID,
    status: 'pending',
    protocolVersion: 1,
    initiatorCommitment: null,
    initiatorCommitmentNonce: null,
    publicKey: identity.publicKey,
    initiatorEphemeralPublicKey: web.publicKey,
    responderEphemeralPublicKey: null,
    nonce: null,
    ciphertext: null,
    receiptSignature: null,
    receiptTimestamp: null,
    expiresAt: '2026-09-16T00:05:00.000Z',
  };
  const relay: MoveRelay = {
    getMove: async () => ({ ...state }),
    joinMove: async (_id, responderEphemeralPublicKey) => {
      if (state.status !== 'pending') throw new Error('This move is no longer waiting for a device');
      state = { ...state, status: 'joined', responderEphemeralPublicKey };
      return { ...state };
    },
    postReceipt: async (_id, receipt) => {
      state = { ...state, status: 'completed', nonce: null, ciphertext: null, receiptSignature: receipt.signature, receiptTimestamp: receipt.timestamp };
      return { ...state };
    },
  };
  const webSeal = () => {
    const key = deriveMoveKey(web.privateKey, state.responderEphemeralPublicKey as string, MOVE_ID);
    state = { ...state, status: 'sealed', ...sealIdentityForMove(identity, key, MOVE_ID) };
  };
  return {
    identity,
    web,
    relay,
    webSeal,
    get state() {
      return state;
    },
    set: (patch: Partial<IdentityMoveState>) => {
      state = { ...state, ...patch };
    },
  };
}

describe('receiving a moved identity (protocol version 1, a web page loaded before the upgrade)', () => {
  it('shows the web’s code, opens the sealed identity and signs a receipt the web accepts', async () => {
    const ctx = setup();
    const move = await joinMove(ctx.relay, MOVE_ID);

    expect(move.sas).toBe(deriveMoveSas(MOVE_ID, ctx.web.publicKey, ctx.state.responderEphemeralPublicKey as string));
    expect(await receiveIdentity(ctx.relay, move)).toBeNull();

    ctx.webSeal();
    const identity = await receiveIdentity(ctx.relay, move);
    expect(identity?.mnemonic).toBe(ctx.identity.mnemonic);

    await confirmReceived(ctx.relay, move, identity!);
    expect(
      await verifyMoveReceipt(ctx.identity.publicKey, MOVE_ID, {
        signature: ctx.state.receiptSignature as string,
        timestamp: ctx.state.receiptTimestamp as number,
      }),
    ).toBe(true);

    forgetMove(move);
    expect(move.ephemeral.privateKey).toBe('');
  });

  it('cannot join a move another device already joined', async () => {
    const ctx = setup();
    await joinMove(ctx.relay, MOVE_ID);
    await expect(joinMove(ctx.relay, MOVE_ID)).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('refuses a relay that swaps the web key after the codes were shown', async () => {
    const ctx = setup();
    const move = await joinMove(ctx.relay, MOVE_ID);
    ctx.set({ initiatorEphemeralPublicKey: generateMoveEphemeralKeyPair().publicKey });
    await expect(receiveIdentity(ctx.relay, move)).rejects.toMatchObject({ reason: 'tampered' });
  });

  it('refuses a different identity than the one the move declared', async () => {
    const ctx = setup();
    const move = await joinMove(ctx.relay, MOVE_ID);
    ctx.webSeal();
    ctx.set({ publicKey: generateWebIdentity().publicKey });
    await expect(receiveIdentity(ctx.relay, move)).rejects.toMatchObject({ reason: 'tampered' });
  });

  it('refuses ciphertext it cannot open', async () => {
    const ctx = setup();
    const move = await joinMove(ctx.relay, MOVE_ID);
    ctx.set({ status: 'sealed', nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(64) });
    await expect(receiveIdentity(ctx.relay, move)).rejects.toMatchObject({ reason: 'tampered' });
  });

  it('reports a cancelled or expired move as ended', async () => {
    const ctx = setup();
    const move = await joinMove(ctx.relay, MOVE_ID);
    ctx.set({ status: 'cancelled' });
    await expect(receiveIdentity(ctx.relay, move)).rejects.toMatchObject({ reason: 'ended' });
  });
});

/* ------------------------------------------------------------------------- */
/* Protocol version 2 (#1302): commitment first, key revealed after the join. */
/* ------------------------------------------------------------------------- */

function setupV2() {
  const identity = generateWebIdentity();
  const web = generateMoveEphemeralKeyPair();
  const { commitment, nonce } = createMoveCommitment(web.publicKey);
  let state: IdentityMoveState = {
    moveId: MOVE_ID,
    status: 'pending',
    protocolVersion: 2,
    initiatorCommitment: commitment,
    initiatorCommitmentNonce: null,
    publicKey: identity.publicKey,
    initiatorEphemeralPublicKey: null,
    responderEphemeralPublicKey: null,
    nonce: null,
    ciphertext: null,
    receiptSignature: null,
    receiptTimestamp: null,
    expiresAt: '2026-09-16T00:05:00.000Z',
  };
  const relay: MoveRelay = {
    getMove: async () => ({ ...state }),
    joinMove: async (_id, responderEphemeralPublicKey) => {
      if (state.status !== 'pending') throw new Error('This move is no longer waiting for a device');
      state = { ...state, status: 'joined', responderEphemeralPublicKey };
      return { ...state };
    },
    postReceipt: async (_id, receipt) => {
      state = { ...state, status: 'completed', nonce: null, ciphertext: null, receiptSignature: receipt.signature, receiptTimestamp: 1 };
      return { ...state };
    },
  };
  let sealedPayload: { nonce: string; ciphertext: string } | null = null;
  return {
    identity,
    web,
    relay,
    reveal: (key = web.publicKey, withNonce = nonce) => {
      state = { ...state, initiatorEphemeralPublicKey: key, initiatorCommitmentNonce: withNonce };
    },
    webSeal: () => {
      const key = deriveMoveKey(web.privateKey, state.responderEphemeralPublicKey as string, MOVE_ID);
      sealedPayload = sealIdentityForMove(identity, key, MOVE_ID);
      state = { ...state, status: 'sealed', ...sealedPayload };
    },
    get sealed() {
      return sealedPayload;
    },
    get state() {
      return state;
    },
    set: (patch: Partial<IdentityMoveState>) => {
      state = { ...state, ...patch };
    },
  };
}

describe('receiving a moved identity (protocol version 2)', () => {
  it('shows no code until the revealed key opens the commitment, then receives and signs with the STORED key', async () => {
    const ctx = setupV2();
    const move = await joinMove(ctx.relay, MOVE_ID);
    expect(move.sas).toBeNull();
    expect(await awaitCode(ctx.relay, move)).toBe(false);

    ctx.reveal();
    expect(await awaitCode(ctx.relay, move)).toBe(true);
    expect(move.sas).toBe(
      deriveMoveSasV2({ moveId: MOVE_ID, initiatorEphemeralPublicKey: ctx.web.publicKey, responderEphemeralPublicKey: move.ephemeral.publicKey, initiatorCommitment: ctx.state.initiatorCommitment as string }),
    );

    ctx.webSeal();
    const identity = await receiveIdentity(ctx.relay, move);
    expect(identity?.mnemonic).toBe(ctx.identity.mnemonic);

    // A signer that reads the key back from storage; here, the stored key is the identity.
    const stored: string[] = [];
    await confirmReceived(ctx.relay, move, identity!, async (message) => {
      stored.push(message);
      return signMessage(message, ctx.identity.privateKey);
    });
    expect(stored).toHaveLength(1);
    expect(
      await verifyMoveReceiptV2(
        {
          moveId: MOVE_ID,
          rootPublicKey: ctx.identity.publicKey,
          initiatorEphemeralPublicKey: ctx.web.publicKey,
          responderEphemeralPublicKey: move.ephemeral.publicKey,
          ciphertextDigest: digestMoveCiphertext(ctx.sealed!),
        },
        ctx.state.receiptSignature as string,
      ),
    ).toBe(true);
  });

  it('refuses to join a version-2 move whose key is already public', async () => {
    const ctx = setupV2();
    ctx.set({ initiatorEphemeralPublicKey: ctx.web.publicKey });
    await expect(joinMove(ctx.relay, MOVE_ID)).rejects.toMatchObject({ reason: 'tampered' });
  });

  it('refuses a revealed key the commitment does not open — the relay cannot substitute it', async () => {
    const ctx = setupV2();
    const move = await joinMove(ctx.relay, MOVE_ID);
    ctx.reveal(generateMoveEphemeralKeyPair().publicKey);
    await expect(awaitCode(ctx.relay, move)).rejects.toMatchObject({ reason: 'tampered' });
    expect(move.sas).toBeNull();
  });

  it('refuses a commitment swapped after joining', async () => {
    const ctx = setupV2();
    const move = await joinMove(ctx.relay, MOVE_ID);
    const swapped = createMoveCommitment(generateMoveEphemeralKeyPair().publicKey);
    ctx.set({ initiatorCommitment: swapped.commitment });
    await expect(awaitCode(ctx.relay, move)).rejects.toMatchObject({ reason: 'tampered' });
  });

  it('never signs a version-2 receipt without a signer that reads storage', async () => {
    const ctx = setupV2();
    const move = await joinMove(ctx.relay, MOVE_ID);
    ctx.reveal();
    await awaitCode(ctx.relay, move);
    ctx.webSeal();
    const identity = await receiveIdentity(ctx.relay, move);
    await expect(confirmReceived(ctx.relay, move, identity!)).rejects.toMatchObject({ reason: 'tampered' });
    expect(ctx.state.status).toBe('sealed');
  });
});
