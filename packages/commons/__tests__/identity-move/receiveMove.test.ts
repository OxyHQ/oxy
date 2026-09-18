import {
  createMoveCommitment,
  deriveMoveKey,
  deriveMoveSas,
  digestMoveCiphertext,
  generateMoveEphemeralKeyPair,
  generateWebIdentity,
  sealIdentityForMove,
  verifyMoveReceipt,
} from '@oxy.so/core';
import type { IdentityMoveState } from '@oxy.so/contracts';
import { signMessage } from '@oxy.so/protocol';
import { awaitCode, confirmReceived, forgetMove, joinMove, receiveIdentity, type MoveRelay } from '@/lib/identity-move/receiveMove';

const MOVE_ID = '0123456789abcdef0123456789abcdef';

/** The web side (commitment first, key revealed after the join) and an in-memory relay that behaves like the API. */
function setup() {
  const identity = generateWebIdentity();
  const web = generateMoveEphemeralKeyPair();
  const { commitment, nonce } = createMoveCommitment(web.publicKey);
  let state: IdentityMoveState = {
    moveId: MOVE_ID,
    status: 'pending',
    initiatorCommitment: commitment,
    initiatorCommitmentNonce: null,
    publicKey: identity.publicKey,
    initiatorEphemeralPublicKey: null,
    responderEphemeralPublicKey: null,
    nonce: null,
    ciphertext: null,
    receiptSignature: null,
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
      state = { ...state, status: 'completed', nonce: null, ciphertext: null, receiptSignature: receipt.signature };
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

/** Join, reveal and compute the code — the state right before the person compares. */
async function joined(ctx: ReturnType<typeof setup>) {
  const move = await joinMove(ctx.relay, MOVE_ID);
  ctx.reveal();
  await awaitCode(ctx.relay, move);
  return move;
}

describe('receiving a moved identity', () => {
  it('shows no code until the revealed key opens the commitment, then receives and signs with the STORED key', async () => {
    const ctx = setup();
    const move = await joinMove(ctx.relay, MOVE_ID);
    expect(move.sas).toBeNull();
    expect(await awaitCode(ctx.relay, move)).toBe(false);

    ctx.reveal();
    expect(await awaitCode(ctx.relay, move)).toBe(true);
    expect(move.sas).toBe(
      deriveMoveSas({ moveId: MOVE_ID, initiatorEphemeralPublicKey: ctx.web.publicKey, responderEphemeralPublicKey: move.ephemeral.publicKey, initiatorCommitment: ctx.state.initiatorCommitment }),
    );
    expect(await receiveIdentity(ctx.relay, move)).toBeNull();

    ctx.webSeal();
    const identity = await receiveIdentity(ctx.relay, move);
    expect(identity?.mnemonic).toBe(ctx.identity.mnemonic);

    // A signer that reads the key back from storage; here, the stored key is the identity.
    const stored: string[] = [];
    await confirmReceived(ctx.relay, move, async (message) => {
      stored.push(message);
      return signMessage(message, ctx.identity.privateKey);
    });
    expect(stored).toHaveLength(1);
    expect(
      await verifyMoveReceipt(
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

    forgetMove(move);
    expect(move.ephemeral.privateKey).toBe('');
  });

  it('cannot join a move another device already joined', async () => {
    const ctx = setup();
    await joinMove(ctx.relay, MOVE_ID);
    await expect(joinMove(ctx.relay, MOVE_ID)).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('refuses to join a move whose key is already public', async () => {
    const ctx = setup();
    ctx.set({ initiatorEphemeralPublicKey: ctx.web.publicKey });
    await expect(joinMove(ctx.relay, MOVE_ID)).rejects.toMatchObject({ reason: 'tampered' });
  });

  it('refuses a revealed key the commitment does not open — the relay cannot substitute it', async () => {
    const ctx = setup();
    const move = await joinMove(ctx.relay, MOVE_ID);
    ctx.reveal(generateMoveEphemeralKeyPair().publicKey);
    await expect(awaitCode(ctx.relay, move)).rejects.toMatchObject({ reason: 'tampered' });
    expect(move.sas).toBeNull();
  });

  it('refuses a commitment swapped after joining', async () => {
    const ctx = setup();
    const move = await joinMove(ctx.relay, MOVE_ID);
    ctx.set({ initiatorCommitment: createMoveCommitment(generateMoveEphemeralKeyPair().publicKey).commitment });
    await expect(awaitCode(ctx.relay, move)).rejects.toMatchObject({ reason: 'tampered' });
  });

  it('refuses a relay that swaps the web key after the codes were shown', async () => {
    const ctx = setup();
    const move = await joined(ctx);
    ctx.set({ initiatorEphemeralPublicKey: generateMoveEphemeralKeyPair().publicKey });
    await expect(receiveIdentity(ctx.relay, move)).rejects.toMatchObject({ reason: 'tampered' });
  });

  it('refuses a different identity than the one the move declared', async () => {
    const ctx = setup();
    const move = await joined(ctx);
    ctx.webSeal();
    ctx.set({ publicKey: generateWebIdentity().publicKey });
    await expect(receiveIdentity(ctx.relay, move)).rejects.toMatchObject({ reason: 'tampered' });
  });

  it('refuses ciphertext it cannot open', async () => {
    const ctx = setup();
    const move = await joined(ctx);
    ctx.set({ status: 'sealed', nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(64) });
    await expect(receiveIdentity(ctx.relay, move)).rejects.toMatchObject({ reason: 'tampered' });
  });

  it('reports a cancelled or expired move as ended', async () => {
    const ctx = setup();
    const move = await joined(ctx);
    ctx.set({ status: 'cancelled' });
    await expect(receiveIdentity(ctx.relay, move)).rejects.toMatchObject({ reason: 'ended' });
  });

  it('never signs a receipt for ciphertext it did not open', async () => {
    const ctx = setup();
    const move = await joined(ctx);
    await expect(confirmReceived(ctx.relay, move, async () => 'sig')).rejects.toMatchObject({ reason: 'tampered' });
    expect(ctx.state.receiptSignature).toBeNull();
  });
});
