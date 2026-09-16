import {
  deriveMoveKey,
  deriveMoveSas,
  generateMoveEphemeralKeyPair,
  IDENTITY_MOVE_ACTIONS,
  openMovedIdentity,
  signMoveAction,
  type OpenedWebIdentity,
} from '@oxy.so/core';
import type { IdentityMoveState } from '@oxy.so/contracts';

/**
 * Receiving an identity moved from the web (`id.oxy.so`) — the Commons side.
 *
 * The web shows a QR carrying only a move id. This device joins with a fresh
 * ephemeral key, both screens show the same 6-digit code, and once the person
 * confirms on the web the identity arrives sealed to this device's key. After
 * the identity is stored here, a receipt signed with the identity key tells the
 * web it may destroy its copy.
 *
 * Every read re-checks that the move still names the keys this device joined
 * with, so a relay that swaps a key mid-move gets nothing opened or imported.
 */

/** The unauthenticated relay endpoints this device uses (it has no identity yet). */
export interface MoveRelay {
  getMove(moveId: string): Promise<IdentityMoveState>;
  joinMove(moveId: string, responderEphemeralPublicKey: string): Promise<IdentityMoveState>;
  postReceipt(moveId: string, receipt: { signature: string; timestamp: number }): Promise<IdentityMoveState>;
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
  /** The identity being moved, as declared when the web started the move. */
  publicKey: string;
  initiatorEphemeralPublicKey: string;
  ephemeral: { privateKey: string; publicKey: string };
  /** The code to compare with the web screen. */
  sas: string;
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

/** Join the move in a scanned QR and compute the code to compare. */
export async function joinMove(relay: MoveRelay, moveId: string): Promise<IncomingMove> {
  const ephemeral = generateMoveEphemeralKeyPair();
  let state: IdentityMoveState;
  try {
    state = await relay.joinMove(moveId, ephemeral.publicKey);
  } catch (error) {
    throw new MoveError('unavailable', error instanceof Error ? error.message : 'This code can no longer be used');
  }
  if (state.moveId !== moveId || state.status !== 'joined' || state.responderEphemeralPublicKey !== ephemeral.publicKey) {
    throw new MoveError('tampered', 'The move could not be verified');
  }
  return {
    moveId,
    publicKey: state.publicKey,
    initiatorEphemeralPublicKey: state.initiatorEphemeralPublicKey,
    ephemeral,
    sas: deriveMoveSas(moveId, state.initiatorEphemeralPublicKey, ephemeral.publicKey),
  };
}

/**
 * Check on the move. Returns the identity once the web sealed it — opened with
 * this device's key and checked against the declared public key — or `null`
 * while the person has not confirmed yet.
 */
export async function receiveIdentity(relay: MoveRelay, move: IncomingMove): Promise<OpenedWebIdentity | null> {
  const state = await relay.getMove(move.moveId);
  if (
    state.moveId !== move.moveId ||
    state.publicKey !== move.publicKey ||
    state.initiatorEphemeralPublicKey !== move.initiatorEphemeralPublicKey ||
    state.responderEphemeralPublicKey !== move.ephemeral.publicKey
  ) {
    throw new MoveError('tampered', 'The move could not be verified');
  }
  if (state.status === 'joined') return null;
  if (state.status !== 'sealed' || !state.nonce || !state.ciphertext) {
    throw new MoveError('ended', 'The move was cancelled or expired');
  }
  const moveKey = deriveMoveKey(move.ephemeral.privateKey, move.initiatorEphemeralPublicKey, move.moveId);
  try {
    return openMovedIdentity({ nonce: state.nonce, ciphertext: state.ciphertext }, moveKey, move.moveId, move.publicKey);
  } catch {
    throw new MoveError('tampered', 'The identity could not be opened');
  } finally {
    moveKey.fill(0);
  }
}

/** Tell the web this device holds the identity, proven with the identity key. */
export async function confirmReceived(relay: MoveRelay, move: IncomingMove, identity: Pick<OpenedWebIdentity, 'privateKey'>): Promise<void> {
  const receipt = await signMoveAction(identity, IDENTITY_MOVE_ACTIONS.received, move.moveId);
  await relay.postReceipt(move.moveId, receipt);
}

/** Forget this device's ephemeral key once the move is over. */
export function forgetMove(move: IncomingMove): void {
  (move.ephemeral as { privateKey: string }).privateKey = '';
}
