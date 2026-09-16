import {
  deriveMoveKey,
  deriveMoveSas,
  deriveMoveSasV2,
  digestMoveCiphertext,
  generateMoveEphemeralKeyPair,
  IDENTITY_MOVE_ACTIONS,
  openMovedIdentity,
  signMoveAction,
  signMoveReceiptV2,
  verifyMoveCommitment,
  type OpenedMnemonicIdentity,
} from '@oxy.so/core';
import type { IdentityMoveState } from '@oxy.so/contracts';

/**
 * Receiving an identity from the web — the Commons side.
 *
 * The web shows a QR carrying only a move id. This device reads the move, joins
 * with a fresh ephemeral key, both screens show the same 6-digit code, and once
 * the person confirms on the web the identity arrives sealed to this device's
 * key. After the identity is stored here AND read back from storage, a receipt
 * signed with the stored key tells the web it arrived.
 *
 * PROTOCOL VERSION 2 (#1302): the web's key is hidden behind a commitment this
 * device reads BEFORE choosing its own key, and revealed only afterwards. The
 * code is shown only once the revealed key opens that commitment. A relay can no
 * longer grind substituted keys until both codes agree. Version 1 moves (a web
 * page loaded before the upgrade) still complete.
 *
 * Every read re-checks that the move still names the keys this device joined
 * with, so a relay that swaps a key mid-move gets nothing opened or imported.
 */

/** The unauthenticated relay endpoints this device uses (it has no identity yet). */
export interface MoveRelay {
  getMove(moveId: string): Promise<IdentityMoveState>;
  joinMove(moveId: string, responderEphemeralPublicKey: string): Promise<IdentityMoveState>;
  postReceipt(moveId: string, receipt: { signature: string; timestamp: number } | { v: 2; signature: string }): Promise<IdentityMoveState>;
}

type RequestClient = {
  makeRequest<T>(method: 'GET' | 'POST', url: string, data?: unknown, options?: { cache?: boolean }): Promise<T>;
};

export function createMoveRelay(client: RequestClient): MoveRelay {
  const path = (moveId: string) => `/identity/move/${encodeURIComponent(moveId)}`;
  return {
    getMove: (moveId) => client.makeRequest<IdentityMoveState>('GET', path(moveId), undefined, { cache: false }),
    joinMove: (moveId, responderEphemeralPublicKey) =>
      client.makeRequest<IdentityMoveState>('POST', `${path(moveId)}/join`, { responderEphemeralPublicKey }, { cache: false }),
    postReceipt: (moveId, receipt) =>
      client.makeRequest<IdentityMoveState>('POST', `${path(moveId)}/receipt`, receipt, { cache: false }),
  };
}

/** A move this device joined. The ephemeral private key never leaves memory. */
export interface IncomingMove {
  moveId: string;
  protocolVersion: 1 | 2;
  /** The identity being moved, as declared when the web started the move. */
  publicKey: string;
  /** Version 2: the commitment read before joining. */
  initiatorCommitment: string | null;
  /** Known at join in version 1; in version 2 only once revealed AND verified. */
  initiatorEphemeralPublicKey: string | null;
  ephemeral: { privateKey: string; publicKey: string };
  /** The code to compare with the web screen; `null` until it can be computed honestly. */
  sas: string | null;
  /** Version 2: the digest of the ciphertext this device opened, bound into the receipt. */
  ciphertextDigest?: string;
}

export class MoveError extends Error {
  constructor(
    readonly reason: 'unavailable' | 'tampered' | 'ended',
    message: string,
  ) {
    super(message);
    this.name = 'MoveError';
  }
}

/** Read the move, then join it with a fresh key. In version 2 the code comes later, from {@link awaitCode}. */
export async function joinMove(relay: MoveRelay, moveId: string): Promise<IncomingMove> {
  let before: IdentityMoveState;
  try {
    before = await relay.getMove(moveId);
  } catch (error) {
    throw new MoveError('unavailable', error instanceof Error ? error.message : 'This code can no longer be used');
  }
  if (before.moveId !== moveId || before.status !== 'pending') {
    throw new MoveError('unavailable', 'This code can no longer be used');
  }
  const version: 1 | 2 = before.protocolVersion === 2 ? 2 : 1;
  if (version === 2 && (!before.initiatorCommitment || before.initiatorEphemeralPublicKey !== null)) {
    // A version-2 move whose key is already public was not committed to first.
    throw new MoveError('tampered', 'The move could not be verified');
  }

  const ephemeral = generateMoveEphemeralKeyPair();
  let state: IdentityMoveState;
  try {
    state = await relay.joinMove(moveId, ephemeral.publicKey);
  } catch (error) {
    throw new MoveError('unavailable', error instanceof Error ? error.message : 'This code can no longer be used');
  }
  if (state.moveId !== moveId || state.status !== 'joined' || state.responderEphemeralPublicKey !== ephemeral.publicKey || state.publicKey !== before.publicKey) {
    throw new MoveError('tampered', 'The move could not be verified');
  }

  if (version === 1) {
    if (!state.initiatorEphemeralPublicKey) throw new MoveError('tampered', 'The move could not be verified');
    return {
      moveId,
      protocolVersion: 1,
      publicKey: state.publicKey,
      initiatorCommitment: null,
      initiatorEphemeralPublicKey: state.initiatorEphemeralPublicKey,
      ephemeral,
      sas: deriveMoveSas(moveId, state.initiatorEphemeralPublicKey, ephemeral.publicKey),
    };
  }
  if (state.initiatorCommitment !== before.initiatorCommitment) {
    throw new MoveError('tampered', 'The move could not be verified');
  }
  return {
    moveId,
    protocolVersion: 2,
    publicKey: state.publicKey,
    initiatorCommitment: before.initiatorCommitment,
    initiatorEphemeralPublicKey: null,
    ephemeral,
    sas: null,
  };
}

/**
 * Version 2: once the web revealed its key, check it against the commitment read
 * before joining and compute the code. Returns `true` when the code is ready,
 * `false` while the web has not revealed yet.
 */
export async function awaitCode(relay: MoveRelay, move: IncomingMove): Promise<boolean> {
  if (move.sas) return true;
  const state = await relay.getMove(move.moveId);
  if (state.moveId !== move.moveId || state.publicKey !== move.publicKey || state.responderEphemeralPublicKey !== move.ephemeral.publicKey || state.initiatorCommitment !== move.initiatorCommitment) {
    throw new MoveError('tampered', 'The move could not be verified');
  }
  if (state.status !== 'joined' && state.status !== 'sealed') {
    throw new MoveError('ended', 'The move was cancelled or expired');
  }
  if (!state.initiatorEphemeralPublicKey) return false;
  if (!state.initiatorCommitmentNonce || !move.initiatorCommitment || !verifyMoveCommitment(state.initiatorEphemeralPublicKey, state.initiatorCommitmentNonce, move.initiatorCommitment)) {
    throw new MoveError('tampered', 'The move could not be verified');
  }
  move.initiatorEphemeralPublicKey = state.initiatorEphemeralPublicKey;
  move.sas = deriveMoveSasV2({
    moveId: move.moveId,
    initiatorEphemeralPublicKey: state.initiatorEphemeralPublicKey,
    responderEphemeralPublicKey: move.ephemeral.publicKey,
    initiatorCommitment: move.initiatorCommitment,
  });
  return true;
}

/**
 * Check on the move. Returns the identity once the web sealed it — opened with
 * this device's key and checked against the declared public key — or `null`
 * while the person has not confirmed yet.
 */
export async function receiveIdentity(relay: MoveRelay, move: IncomingMove): Promise<OpenedMnemonicIdentity | null> {
  if (!move.initiatorEphemeralPublicKey || !move.sas) {
    throw new MoveError('tampered', 'The move could not be verified');
  }
  const state = await relay.getMove(move.moveId);
  if (
    state.moveId !== move.moveId ||
    state.publicKey !== move.publicKey ||
    state.initiatorEphemeralPublicKey !== move.initiatorEphemeralPublicKey ||
    state.responderEphemeralPublicKey !== move.ephemeral.publicKey ||
    (move.protocolVersion === 2 && state.initiatorCommitment !== move.initiatorCommitment)
  ) {
    throw new MoveError('tampered', 'The move could not be verified');
  }
  if (state.status === 'joined') return null;
  if (state.status !== 'sealed' || !state.nonce || !state.ciphertext) {
    throw new MoveError('ended', 'The move was cancelled or expired');
  }
  const moveKey = deriveMoveKey(move.ephemeral.privateKey, move.initiatorEphemeralPublicKey, move.moveId);
  try {
    const identity = openMovedIdentity({ nonce: state.nonce, ciphertext: state.ciphertext }, moveKey, move.moveId, move.publicKey);
    move.ciphertextDigest = digestMoveCiphertext({ nonce: state.nonce, ciphertext: state.ciphertext });
    return identity;
  } catch {
    throw new MoveError('tampered', 'The identity could not be opened');
  } finally {
    moveKey.fill(0);
  }
}

/**
 * Tell the web this device holds the identity.
 *
 * Version 2 signs with `signWithStoredKey` — a signer that reads the key back
 * from this device's keychain — over the move, the root, both keys and the
 * ciphertext it opened. A receipt therefore exists only for a root that was
 * actually stored and re-read.
 */
export async function confirmReceived(
  relay: MoveRelay,
  move: IncomingMove,
  identity: Pick<OpenedMnemonicIdentity, 'privateKey'>,
  signWithStoredKey?: (message: string) => Promise<string>,
): Promise<void> {
  if (move.protocolVersion === 1) {
    const receipt = await signMoveAction(identity, IDENTITY_MOVE_ACTIONS.received, move.moveId);
    await relay.postReceipt(move.moveId, receipt);
    return;
  }
  if (!signWithStoredKey || !move.initiatorEphemeralPublicKey || !move.ciphertextDigest) {
    throw new MoveError('tampered', 'The move could not be verified');
  }
  const receipt = await signMoveReceiptV2(signWithStoredKey, {
    moveId: move.moveId,
    rootPublicKey: move.publicKey,
    initiatorEphemeralPublicKey: move.initiatorEphemeralPublicKey,
    responderEphemeralPublicKey: move.ephemeral.publicKey,
    ciphertextDigest: move.ciphertextDigest,
  });
  await relay.postReceipt(move.moveId, receipt);
}

/** Forget this device's ephemeral key once the move is over. */
export function forgetMove(move: IncomingMove): void {
  (move.ephemeral as { privateKey: string }).privateKey = '';
}
