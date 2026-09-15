/**
 * The web identity carrier's decisions, independent of any screen.
 *
 * Every function takes its ports (API, passkeys, local store) explicitly, so the
 * rules that matter — never create a second identity for an account that has
 * one, never overwrite an envelope that does not open, keep going without an
 * identity where PRF is unavailable — are unit-tested without a browser.
 *
 * Design: `docs/superpowers/specs/2026-09-15-one-identity-two-carriers-design.md`.
 */

import {
  deriveMoveKey,
  deriveMoveSas,
  generateMoveEphemeralKeyPair,
  generateWebIdentity,
  IDENTITY_MOVE_ACTIONS,
  sealIdentityForMove,
  sealWebIdentity,
  signIdentityAction,
  signMoveAction,
  unlockWebIdentity,
  verifyMoveReceipt,
  wipeBytes,
  WebIdentityUnlockError,
  type OpenedWebIdentity,
  type WebIdentityUnlockFailure,
} from '@oxy.so/core';
import type { IdentityMoveState, WebIdentityEnvelope, WebIdentityEnvelopeResponse } from '@oxy.so/contracts';
import { signMessage } from '@oxy.so/protocol';
import type { CarrierAccount, IdentityApi } from './api';
import type { CeremonyResult, CreationOptionsJSON, RequestOptionsJSON } from './passkey';

export interface PasskeyPort {
  create(options: CreationOptionsJSON): Promise<CeremonyResult<Record<string, unknown>>>;
  assert(options: RequestOptionsJSON): Promise<CeremonyResult<Record<string, unknown>>>;
  evaluatePrf(credentialId: string): Promise<Uint8Array | null>;
}

export interface LocalEnvelopePort {
  read(userId: string): Promise<WebIdentityEnvelope | null>;
  write(userId: string, envelope: WebIdentityEnvelope): Promise<void>;
  remove(userId: string): Promise<void>;
}

export interface CarrierPorts {
  api: IdentityApi;
  passkeys: PasskeyPort;
  local: LocalEnvelopePort;
}

/** A signed-in person on this origin, with the PRF output of the passkey they used (if any). */
export interface CarrierSession {
  account: CarrierAccount;
  credentialId: string;
  /** `null` where the authenticator or browser provides no PRF (design decision D3). */
  prfOutput: Uint8Array | null;
}

/** Where this account's identity stands, from this browser's point of view. */
export type IdentityState =
  /** The web carrier holds the identity and this passkey opens it. */
  | { kind: 'ready'; envelope: WebIdentityEnvelope; phraseConfirmedAt: string | null }
  /** A brand-new identity was just created here; the phrase has not been shown yet. */
  | { kind: 'created'; envelope: WebIdentityEnvelope; identity: OpenedWebIdentity }
  /** The account has an identity, but it is not carried on the web (it lives in Commons). */
  | { kind: 'elsewhere' }
  /** The web envelope exists but this passkey cannot open it; the phrase or another passkey can. */
  | { kind: 'locked'; failure: WebIdentityUnlockFailure }
  /** This browser/authenticator provides no PRF, so the web carrier cannot be used here. */
  | { kind: 'unsupported' };

/** Sign in with a discoverable passkey — one prompt yields the session AND the PRF output. */
export async function signIn(ports: CarrierPorts): Promise<CarrierSession> {
  const ceremony = await ports.passkeys.assert(await ports.api.loginOptions());
  const account = await ports.api.loginVerify(ceremony.response);
  return { account, credentialId: ceremony.credentialId, prfOutput: ceremony.prfOutput };
}

/**
 * Create an account with a passkey.
 *
 * Many authenticators return no PRF output at `create()`; a second, local
 * ceremony against the new credential recovers it (no server round trip).
 */
export async function signUp(ports: CarrierPorts, username: string): Promise<CarrierSession> {
  const ceremony = await ports.passkeys.create(await ports.api.registerOptions(username));
  const account = await ports.api.registerVerify(ceremony.response, username);
  const prfOutput = ceremony.prfOutput ?? (await ports.passkeys.evaluatePrf(ceremony.credentialId));
  return { account, credentialId: ceremony.credentialId, prfOutput };
}

function openWith(envelope: WebIdentityEnvelope, session: CarrierSession): OpenedWebIdentity {
  if (!session.prfOutput) throw new WebIdentityUnlockError('unknown-credential', 'This passkey provides no secret');
  return unlockWebIdentity(envelope, session.prfOutput, session.credentialId);
}

/**
 * Bring the account's identity to a usable state, creating it only when the
 * account has none.
 *
 * - An account that already has a linked identity is NEVER given a new one: a
 *   second key would silently replace the person's identity.
 * - An existing envelope that this passkey cannot open is reported, not
 *   replaced — overwriting it could destroy the only web copy.
 */
export async function ensureIdentity(ports: CarrierPorts, session: CarrierSession): Promise<IdentityState> {
  const { account } = session;
  const remote: WebIdentityEnvelopeResponse = await ports.api.getEnvelope();

  if (remote.envelope) {
    if (!session.prfOutput) return { kind: 'unsupported' };
    try {
      const identity = openWith(remote.envelope, session);
      wipeIdentity(identity);
    } catch (error) {
      if (error instanceof WebIdentityUnlockError) return { kind: 'locked', failure: error.failure };
      throw error;
    }
    await ports.local.write(account.userId, remote.envelope);
    return { kind: 'ready', envelope: remote.envelope, phraseConfirmedAt: remote.phraseConfirmedAt };
  }

  if (account.publicKey) return { kind: 'elsewhere' };
  if (!session.prfOutput) return { kind: 'unsupported' };

  const identity = generateWebIdentity();
  const { envelope, dataKey } = sealWebIdentity(identity, { prfOutput: session.prfOutput, credentialId: session.credentialId });
  wipeBytes(dataKey);
  // One transaction on the server: never a linked key without its envelope.
  await ports.api.establishIdentity(
    envelope,
    await signIdentityAction(identity, 'link_identity', account.userId),
    await signIdentityAction(identity, 'web_envelope_put', account.userId),
  );
  await ports.local.write(account.userId, envelope);
  return { kind: 'created', envelope, identity };
}

/**
 * Open the identity for one operation. Callers wipe it when done.
 *
 * The server copy is authoritative (an identity moved to Commons must not keep
 * opening from a stale local copy); the local copy is only a fallback when the
 * server cannot be reached.
 */
export async function unlockIdentity(ports: CarrierPorts, session: CarrierSession): Promise<OpenedWebIdentity> {
  let envelope: WebIdentityEnvelope | null;
  try {
    envelope = (await ports.api.getEnvelope()).envelope;
    if (!envelope) await ports.local.remove(session.account.userId);
  } catch {
    envelope = await ports.local.read(session.account.userId);
  }
  if (!envelope) throw new Error('This account has no identity in this browser');
  return openWith(envelope, session);
}

/** Record that the owner wrote the phrase down (design decision D2). */
export async function confirmPhrase(ports: CarrierPorts, session: CarrierSession, identity: OpenedWebIdentity): Promise<string | null> {
  const response = await ports.api.confirmPhrase(await signIdentityAction(identity, 'web_envelope_phrase_confirmed', session.account.userId));
  return response.phraseConfirmedAt;
}

/**
 * Re-seal an identity recovered from its phrase under the passkey just used.
 *
 * Only for the account's OWN identity: the phrase must derive the linked key.
 */
export async function recoverWithPhrase(ports: CarrierPorts, session: CarrierSession, identity: OpenedWebIdentity): Promise<WebIdentityEnvelope> {
  if (!session.prfOutput) throw new Error('This browser cannot keep your identity. Use Safari, Chrome, or the Commons app.');
  if (session.account.publicKey && session.account.publicKey !== identity.publicKey) {
    throw new Error('This recovery phrase belongs to a different identity');
  }
  const { envelope, dataKey } = sealWebIdentity(identity, { prfOutput: session.prfOutput, credentialId: session.credentialId });
  wipeBytes(dataKey);
  const put = await signIdentityAction(identity, 'web_envelope_put', session.account.userId);
  if (session.account.publicKey) {
    await ports.api.putEnvelope(envelope, put);
  } else {
    await ports.api.establishIdentity(envelope, await signIdentityAction(identity, 'link_identity', session.account.userId), put);
  }
  // The person just typed the phrase in, so it is demonstrably saved.
  await ports.api.confirmPhrase(await signIdentityAction(identity, 'web_envelope_phrase_confirmed', session.account.userId));
  await ports.local.write(session.account.userId, envelope);
  return envelope;
}

/** Delete the account, proven with the identity key (`DELETE /users/me`). */
export async function deleteAccount(ports: CarrierPorts, identity: OpenedWebIdentity, confirmText: string): Promise<void> {
  const timestamp = Date.now();
  const signature = await signMessage(`delete:${identity.publicKey}:${timestamp}`, identity.privateKey);
  await ports.api.deleteAccount({ publicKey: identity.publicKey, signature, timestamp, confirmText });
}

/** A move this browser started. The ephemeral private key never leaves memory. */
export interface OutgoingMove {
  moveId: string;
  expiresAt: string;
  ephemeral: { privateKey: string; publicKey: string };
}

/** What the person sees while a move is under way. */
export type MoveProgress =
  /** Waiting for Commons to scan the code. */
  | { kind: 'waiting' }
  /** Commons joined: compare this code on both screens before sending. */
  | { kind: 'compare'; sas: string }
  /** Sent; waiting for Commons to confirm it holds the identity. */
  | { kind: 'sent' }
  /** Commons proved it holds the identity. */
  | { kind: 'received' }
  /** The move ended without the identity changing hands. */
  | { kind: 'ended'; reason: 'expired' | 'cancelled' };

/**
 * Start moving this account's identity to Commons (a MOVE, not a copy).
 *
 * Only an identity this passkey actually opens can be moved — proven before a
 * code is shown, so a person never scans a code that cannot complete.
 */
export async function startMove(ports: CarrierPorts, session: CarrierSession): Promise<OutgoingMove> {
  wipeIdentity(await unlockIdentity(ports, session));
  const ephemeral = generateMoveEphemeralKeyPair();
  const { moveId, expiresAt } = await ports.api.createMove(ephemeral.publicKey);
  return { moveId, expiresAt, ephemeral };
}

/**
 * Read where the move stands. A relay that reports an initiator key other than
 * ours is not showing us our own move, and nothing is sealed to it.
 */
export async function readMove(ports: CarrierPorts, move: OutgoingMove): Promise<{ state: IdentityMoveState; progress: MoveProgress }> {
  const state = await ports.api.getMove(move.moveId);
  if (state.moveId !== move.moveId || state.initiatorEphemeralPublicKey !== move.ephemeral.publicKey) {
    throw new Error('The move could not be verified. Start again.');
  }
  switch (state.status) {
    case 'pending':
      return { state, progress: { kind: 'waiting' } };
    case 'joined':
      if (!state.responderEphemeralPublicKey) throw new Error('The move could not be verified. Start again.');
      return { state, progress: { kind: 'compare', sas: deriveMoveSas(move.moveId, move.ephemeral.publicKey, state.responderEphemeralPublicKey) } };
    case 'sealed':
      return { state, progress: { kind: 'sent' } };
    case 'completed':
      return { state, progress: { kind: 'received' } };
    default:
      return { state, progress: { kind: 'ended', reason: state.status === 'cancelled' ? 'cancelled' : 'expired' } };
  }
}

/**
 * The person confirmed both screens show the same code: seal the identity for
 * the device that joined. The SAS is recomputed from the state being sealed to,
 * so a key swapped after the comparison cannot receive it.
 */
export async function sendMove(ports: CarrierPorts, session: CarrierSession, move: OutgoingMove, confirmedSas: string): Promise<void> {
  const { state, progress } = await readMove(ports, move);
  if (progress.kind !== 'compare' || progress.sas !== confirmedSas || !state.responderEphemeralPublicKey) {
    throw new Error('The code changed. Start again.');
  }
  const identity = await unlockIdentity(ports, session);
  const moveKey = deriveMoveKey(move.ephemeral.privateKey, state.responderEphemeralPublicKey, move.moveId);
  try {
    if (identity.publicKey !== state.publicKey) throw new Error('The move could not be verified. Start again.');
    const sealed = sealIdentityForMove(identity, moveKey, move.moveId);
    await ports.api.sealMove(move.moveId, { ...sealed, ...(await signMoveAction(identity, IDENTITY_MOVE_ACTIONS.seal, move.moveId)) });
  } finally {
    wipeBytes(moveKey);
    wipeIdentity(identity);
  }
}

/**
 * Commons reports the identity received: verify its receipt HERE, with the
 * identity's own public key, and only then destroy the web copy — server and
 * local. A server that claims completion without Commons holding the key
 * cannot make this browser forget the identity.
 */
export async function completeMove(ports: CarrierPorts, session: CarrierSession, move: OutgoingMove, state: IdentityMoveState): Promise<void> {
  if (state.status !== 'completed' || state.receiptSignature === null || state.receiptTimestamp === null) {
    throw new Error('The move is not complete yet');
  }
  const identity = await unlockIdentity(ports, session);
  try {
    if (identity.publicKey !== state.publicKey) throw new Error('The move could not be verified. Start again.');
    const valid = await verifyMoveReceipt(identity.publicKey, move.moveId, { signature: state.receiptSignature, timestamp: state.receiptTimestamp });
    if (!valid) throw new Error('Commons did not prove it received your identity. Your identity is still here.');
    await ports.api.deleteEnvelope(await signIdentityAction(identity, 'web_envelope_delete', session.account.userId));
  } finally {
    wipeIdentity(identity);
  }
  await ports.local.remove(session.account.userId);
  wipeMove(move);
}

/** Give up on a move before it completes. */
export async function cancelMove(ports: CarrierPorts, move: OutgoingMove): Promise<void> {
  try {
    await ports.api.cancelMove(move.moveId);
  } finally {
    wipeMove(move);
  }
}

function wipeMove(move: OutgoingMove): void {
  (move.ephemeral as { privateKey: string }).privateKey = '';
}

/** Best-effort removal of secret strings from an opened identity. */
export function wipeIdentity(identity: OpenedWebIdentity): void {
  (identity as { privateKey: string }).privateKey = '';
  (identity as { mnemonic: string }).mnemonic = '';
}

/**
 * Pick three distinct word positions to ask for back, so "I saved it" is
 * demonstrated rather than clicked through. `random` is injectable for tests.
 */
export function pickConfirmationPositions(wordCount: number, random: () => number = Math.random): number[] {
  const indices = Array.from({ length: wordCount }, (_, index) => index);
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, Math.min(3, wordCount)).sort((a, b) => a - b);
}
