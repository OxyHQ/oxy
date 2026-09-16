import {
  deriveMoveKey,
  deriveMoveSas,
  generateMoveEphemeralKeyPair,
  generateWebIdentity,
  sealIdentityForMove,
  verifyMoveReceipt,
} from '@oxy.so/core';
import type { IdentityMoveState } from '@oxy.so/contracts';
import { confirmReceived, forgetMove, joinMove, receiveIdentity, type MoveRelay } from '@/lib/identity-move/receiveMove';

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

describe('receiving a moved identity', () => {
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
