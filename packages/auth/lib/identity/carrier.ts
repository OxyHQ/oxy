/**
 * The web holder's decisions, independent of any screen.
 *
 * Every function takes its ports (API, passkeys, local store) explicitly, so the
 * rules that matter are unit-tested without a browser (ADR 0024):
 *
 * - **Signing in never opens the root.** A session knows who the person is and
 *   nothing more; holder status comes from metadata the API reports.
 * - **A root operation is one fresh ceremony.** It asks the envelope's own
 *   passkeys for a PRF output under their RP ID, opens the root, performs that
 *   operation, and wipes the material — whatever happens.
 * - **An account is created with its root or not at all.** Without a usable,
 *   stable PRF output nothing is sent to the API.
 * - **The server copy decides.** The local copy is used only when the API cannot
 *   be reached, and only for an operation that writes nothing.
 * - **Recovery needs the root, not the old passkey.**
 */

import {
  createMoveCommitment,
  deriveIdentityFromRecoveryMaterial,
  deriveMoveKey,
  deriveMoveSas,
  digestMoveCiphertext,
  digestIdentityPayload,
  generateMoveEphemeralKeyPair,
  generateWebIdentity,
  normalizeInlineText,
  sealIdentityForMove,
  sealWebIdentity,
  signIdentityProof,
  unlockWebIdentity,
  verifyMoveReceipt,
  wipeBytes,
  wipeOpenedIdentity,
  WebIdentityUnlockError,
  type OpenedMnemonicIdentity,
  type OpenedWebIdentity,
  type WebIdentityRecoveryMaterial,
} from '@oxy.so/core';
import {
  IDENTITY_ERROR_CODES,
  IDENTITY_PROOF_ACTIONS,
  IDENTITY_PROOF_AUDIENCE,
  buildMoveSealPayload,
  type IdentityMoveState,
  type IdentityProof,
  type IdentityProofAction,
  type WebIdentityEnvelope,
  type WebIdentityEnvelopeResponse,
  type WebIdentityHolder,
} from '@oxy.so/contracts';
import { signMessage } from '@oxy.so/protocol';
import { errorCodeOf, httpStatusOf, type CarrierAccount, type IdentityApi } from './api';
import type { Assertion, CreatedPasskey, CreationOptionsJSON, PrfEvaluation, PrfRequest, RequestOptionsJSON } from './passkey';

export interface PasskeyPort {
  create(options: CreationOptionsJSON): Promise<CreatedPasskey>;
  /** Sign-in only: never requests PRF. */
  assert(options: RequestOptionsJSON): Promise<Assertion>;
  /** A root ceremony: PRF under an explicit RP ID. */
  evaluatePrf(request: PrfRequest): Promise<PrfEvaluation>;
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
  now?: () => Date;
}

/** A signed-in person on this origin. Nothing here can open the root. */
export interface CarrierSession {
  account: CarrierAccount;
  /** The passkey that signed in. */
  credentialId: string;
  /** The RP ID that passkey lives under. */
  rpId: string;
}

/** Why a holder operation could not run. Every value is a normal outcome a screen can explain. */
export type HolderFailure =
  /** This browser or passkey provider gives no usable, stable PRF output. */
  | 'prf-unsupported'
  /** The account has no web holder (its root lives elsewhere, e.g. Commons). */
  | 'no-web-holder'
  /** A passkey answered but cannot open the root here; another passkey or the recovery material can. */
  | 'locked'
  /** The recovery material belongs to a different root than this account's. */
  | 'root-mismatch'
  /** The root changed elsewhere since it was read; reload and retry. */
  | 'conflict'
  /** The API cannot be reached, and the operation needs it. */
  | 'offline';

export class HolderError extends Error {
  constructor(
    readonly failure: HolderFailure,
    message: string,
  ) {
    super(message);
    this.name = 'HolderError';
  }
}

/** Where this account's root stands, from metadata alone — nothing was decrypted to learn it. */
export type IdentityStatus =
  | {
      kind: 'ready';
      revision: number;
      holders: WebIdentityHolder[];
      /** Whether the passkey that signed in is one of the holders. */
      signedInWithHolder: boolean;
      /** Whether the root has a phrase (a raw-key root never does). */
      hasPhrase: boolean;
      phraseConfirmedAt: string | null;
      recoveryVerifiedAt: string | null;
    }
  /** A root is linked but no web holder exists (it lives in Commons, or was removed from the web). */
  | { kind: 'elsewhere' }
  /** A legacy passkey-only account with no root at all. */
  | { kind: 'no-root' };

const PROOF_LIFETIME_MS = 4 * 60 * 1000;

function nowOf(ports: CarrierPorts): Date {
  return ports.now?.() ?? new Date();
}

function statusFrom(response: WebIdentityEnvelopeResponse, session: CarrierSession): IdentityStatus {
  if (!response.envelope) {
    return response.rootLinked ? { kind: 'elsewhere' } : { kind: 'no-root' };
  }
  const envelope = response.envelope;
  const holders = response.holders;
  return {
    kind: 'ready',
    revision: response.revision,
    holders,
    signedInWithHolder: holders.some((holder) => holder.credentialId === session.credentialId),
    hasPhrase: envelope.secretKind === 'mnemonic-entropy',
    phraseConfirmedAt: response.phraseConfirmedAt,
    recoveryVerifiedAt: response.recoveryVerifiedAt,
  };
}

function hexOfBase64Url(value: string): string {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  let hex = '';
  for (let index = 0; index < binary.length; index += 1) hex += binary.charCodeAt(index).toString(16).padStart(2, '0');
  return hex;
}

function samePrf(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < a.byteLength; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

function translateApiError(error: unknown): never {
  if (errorCodeOf(error) === IDENTITY_ERROR_CODES.revisionConflict) {
    throw new HolderError('conflict', 'Your identity changed somewhere else. Reload and try again.');
  }
  if (httpStatusOf(error) === null) {
    throw new HolderError('offline', 'You’re offline. Connect and try again.');
  }
  throw error;
}

const PRF_UNSUPPORTED_MESSAGE =
  'This browser or passkey provider can’t keep your Oxy identity. Use Safari or Chrome with your device’s passkeys, or the Commons app.';

/* -------------------------------------------------------------------------- */
/* Authentication                                                              */
/* -------------------------------------------------------------------------- */

/** Sign in with a discoverable passkey. Authentication only — the root stays sealed. */
export async function signIn(ports: CarrierPorts): Promise<CarrierSession> {
  const options = await ports.api.loginOptions();
  const assertion = await ports.passkeys.assert(options);
  const account = await ports.api.loginVerify(assertion.response);
  return { account, credentialId: assertion.credentialId, rpId: options.rpId ?? globalThis.location?.hostname ?? '' };
}

/** The account's holder status. Reads metadata; opens nothing. */
export async function readIdentityStatus(ports: CarrierPorts, session: CarrierSession): Promise<IdentityStatus> {
  let response: WebIdentityEnvelopeResponse;
  try {
    response = await ports.api.getEnvelope();
  } catch (error) {
    translateApiError(error);
  }
  if (!response.envelope) await ports.local.remove(session.account.userId);
  else await ports.local.write(session.account.userId, response.envelope);
  return statusFrom(response, session);
}

/* -------------------------------------------------------------------------- */
/* Root operations                                                             */
/* -------------------------------------------------------------------------- */

/** The current envelope and revision. The server decides; the local copy only when the API is unreachable. */
async function loadEnvelope(
  ports: CarrierPorts,
  session: CarrierSession,
  allowOffline: boolean,
): Promise<{ envelope: WebIdentityEnvelope; revision: number | null }> {
  try {
    const response = await ports.api.getEnvelope();
    if (!response.envelope) {
      await ports.local.remove(session.account.userId);
      throw new HolderError('no-web-holder', 'Your identity isn’t kept in this browser.');
    }
    await ports.local.write(session.account.userId, response.envelope);
    return { envelope: response.envelope, revision: response.revision };
  } catch (error) {
    if (error instanceof HolderError) throw error;
    // An answer from the API — revoked, unauthorized, failing — is never
    // overridden by a stale local copy. Only "no answer at all" is.
    if (httpStatusOf(error) !== null || !allowOffline) translateApiError(error);
    const local = await ports.local.read(session.account.userId);
    if (!local) throw new HolderError('offline', 'You’re offline. Connect and try again.');
    return { envelope: local, revision: null };
  }
}

/** Run one PRF ceremony over the envelope's own passkeys and open the root. The caller wipes it. */
async function openEnvelope(ports: CarrierPorts, session: CarrierSession, envelope: WebIdentityEnvelope): Promise<{ identity: OpenedWebIdentity; credentialId: string }> {
  const rpId = envelope.wraps.find((wrap) => wrap.credentialId === session.credentialId)?.rpId ?? envelope.wraps[0].rpId;
  const credentialIds = envelope.wraps.filter((wrap) => wrap.rpId === rpId).map((wrap) => wrap.credentialId);
  const evaluation = await ports.passkeys.evaluatePrf({ rpId, credentialIds });
  if (!evaluation.prfOutput) throw new HolderError('prf-unsupported', PRF_UNSUPPORTED_MESSAGE);
  try {
    return { identity: unlockWebIdentity(envelope, evaluation.prfOutput, evaluation.credentialId), credentialId: evaluation.credentialId };
  } catch (error) {
    if (error instanceof WebIdentityUnlockError && error.failure !== 'corrupt') {
      throw new HolderError('locked', 'This passkey can’t open your identity here. Use another passkey, or your recovery phrase.');
    }
    throw error;
  } finally {
    wipeBytes(evaluation.prfOutput);
  }
}

/**
 * Open the root for exactly one operation and wipe it afterwards, whatever
 * happens. `allowOffline` only for operations that write nothing.
 */
export async function withRoot<T>(
  ports: CarrierPorts,
  session: CarrierSession,
  run: (identity: OpenedWebIdentity, state: { envelope: WebIdentityEnvelope; revision: number | null; credentialId: string }) => Promise<T>,
  options: { allowOffline?: boolean } = {},
): Promise<T> {
  const { envelope, revision } = await loadEnvelope(ports, session, options.allowOffline === true);
  const { identity, credentialId } = await openEnvelope(ports, session, envelope);
  try {
    return await run(identity, { envelope, revision, credentialId });
  } finally {
    wipeOpenedIdentity(identity);
  }
}

/**
 * Open the root to SHOW the recovery phrase. The screen holds it only while it is
 * visible and must {@link wipeIdentity} it when it closes.
 */
export async function openRootForDisplay(ports: CarrierPorts, session: CarrierSession): Promise<OpenedWebIdentity> {
  const { envelope } = await loadEnvelope(ports, session, true);
  return (await openEnvelope(ports, session, envelope)).identity;
}

/** A root proof for `action` on the signed-in account, over a fresh one-use challenge. */
async function proveForAccount(
  ports: CarrierPorts,
  session: CarrierSession,
  identity: OpenedWebIdentity,
  action: IdentityProofAction,
  claims: { payload?: unknown; expectedRevision?: number | null } = {},
): Promise<IdentityProof> {
  let challenge;
  try {
    challenge = await ports.api.proofChallenge(action);
  } catch (error) {
    translateApiError(error);
  }
  return signIdentityProof(identity, {
    action,
    subject: session.account.userId,
    actor: session.account.userId,
    rootPublicKey: identity.publicKey,
    payloadDigest: claims.payload === undefined ? null : digestIdentityPayload(claims.payload),
    expectedRevision: claims.expectedRevision ?? null,
    audience: challenge.audience,
    challenge: challenge.challenge,
    expiresAt: challenge.expiresAt,
  });
}

/** Record that the owner wrote the recovery phrase down. */
export async function confirmPhrase(ports: CarrierPorts, session: CarrierSession, identity: OpenedWebIdentity): Promise<IdentityStatus> {
  const { revision } = await loadEnvelope(ports, session, false);
  const expectedRevision = revision ?? 0;
  try {
    const proof = await proveForAccount(ports, session, identity, IDENTITY_PROOF_ACTIONS.phraseConfirmed, { expectedRevision });
    return statusFrom(await ports.api.confirmPhrase({ proof, expectedRevision }), session);
  } catch (error) {
    if (error instanceof HolderError) throw error;
    translateApiError(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Creating a root                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The PRF output of a passkey just created, from a ceremony of its own under its
 * RP ID — the same kind of ceremony every later unlock runs. When the
 * authenticator also gave one at `create()`, the two must agree.
 */
async function stablePrfOfNewPasskey(ports: CarrierPorts, created: CreatedPasskey): Promise<Uint8Array> {
  const evaluation = await ports.passkeys.evaluatePrf({ rpId: created.rpId, credentialIds: [created.credentialId] });
  try {
    if (evaluation.credentialId !== created.credentialId || !evaluation.prfOutput) {
      throw new HolderError('prf-unsupported', PRF_UNSUPPORTED_MESSAGE);
    }
    if (created.prfOutput && !samePrf(created.prfOutput, evaluation.prfOutput)) {
      throw new HolderError('prf-unsupported', PRF_UNSUPPORTED_MESSAGE);
    }
    return new Uint8Array(evaluation.prfOutput);
  } finally {
    if (evaluation.prfOutput) wipeBytes(evaluation.prfOutput);
    if (created.prfOutput) wipeBytes(created.prfOutput);
  }
}

/** Seal `identity` under one passkey, re-open it to prove the envelope works, and return it. */
function sealAndReopen(
  ports: CarrierPorts,
  identity: OpenedWebIdentity,
  wrap: { prfOutput: Uint8Array; credentialId: string; rpId: string },
): WebIdentityEnvelope {
  const now = nowOf(ports);
  const { envelope, dataKey } = sealWebIdentity(identity, { ...wrap, verifiedAt: now.toISOString() }, now);
  wipeBytes(dataKey);
  const reopened = unlockWebIdentity(envelope, wrap.prfOutput, wrap.credentialId);
  const matches = reopened.publicKey === identity.publicKey;
  wipeOpenedIdentity(reopened);
  if (!matches) throw new Error('The identity could not be sealed. Nothing was created.');
  return envelope;
}

/**
 * Create an account WITH its root (ADR 0024 D4).
 *
 * The passkey is created, its PRF output confirmed in a second ceremony, the root
 * generated, sealed and re-opened — all before the API hears of the account. The
 * API then creates the account, passkey, root and envelope in one transaction.
 * Without a usable PRF output no account exists; the passkey the authenticator
 * made is unknown to Oxy and harmless.
 *
 * Returns the new root for the phrase screen; the caller wipes it.
 */
export async function signUp(ports: CarrierPorts, username: string): Promise<{ session: CarrierSession; identity: OpenedMnemonicIdentity }> {
  const handle = normalizeInlineText(username);
  const options = await ports.api.registerOptions(handle);
  const created = await ports.passkeys.create(options);
  const prfOutput = await stablePrfOfNewPasskey(ports, created);

  const identity = generateWebIdentity();
  try {
    const envelope = sealAndReopen(ports, identity, { prfOutput, credentialId: created.credentialId, rpId: created.rpId });
    const proof = await signIdentityProof(identity, {
      action: IDENTITY_PROOF_ACTIONS.enroll,
      subject: `username:${handle}`,
      actor: `credential:${created.credentialId}`,
      rootPublicKey: identity.publicKey,
      payloadDigest: digestIdentityPayload({ envelope }),
      expectedRevision: null,
      audience: IDENTITY_PROOF_AUDIENCE,
      challenge: hexOfBase64Url(options.challenge),
      expiresAt: nowOf(ports).getTime() + PROOF_LIFETIME_MS,
    });
    let account: CarrierAccount;
    try {
      account = await ports.api.registerVerify(created.response, handle, { envelope, proof });
    } catch (error) {
      if (httpStatusOf(error) !== null) throw error;
      // No answer: the request may or may not have landed. Retrying the same
      // body is safe — a second commit is impossible (the registration
      // challenge is one use) and a committed account answers 401 here, which
      // tells the person to sign in with the passkey they just made.
      account = await ports.api.registerVerify(created.response, handle, { envelope, proof });
    }
    await ports.local.write(account.userId, envelope);
    return { session: { account, credentialId: created.credentialId, rpId: created.rpId }, identity };
  } catch (error) {
    wipeOpenedIdentity(identity);
    throw error;
  } finally {
    wipeBytes(prfOutput);
  }
}

/**
 * Give a signed-in account with NO root its first one, or add a web holder to an
 * account whose root has none here, from the recovery material (ADR 0024 D8).
 *
 * The same passkey ceremony yields the PRF output the root is sealed under AND a
 * fresh assertion over the server's proof challenge — the API needs both.
 */
export async function establishRoot(
  ports: CarrierPorts,
  session: CarrierSession,
  material?: WebIdentityRecoveryMaterial,
): Promise<{ identity: OpenedWebIdentity; status: IdentityStatus }> {
  const identity: OpenedWebIdentity = material ? deriveIdentityFromRecoveryMaterial(material) : generateWebIdentity();
  try {
    if (session.account.publicKey && session.account.publicKey !== identity.publicKey) {
      throw new HolderError('root-mismatch', 'This recovery phrase belongs to a different identity.');
    }
    let challenge;
    try {
      challenge = await ports.api.proofChallenge(IDENTITY_PROOF_ACTIONS.establish);
    } catch (error) {
      translateApiError(error);
    }
    const evaluation = await ports.passkeys.evaluatePrf({
      rpId: session.rpId,
      credentialIds: [session.credentialId],
      challengeHex: challenge.challenge,
    });
    if (!evaluation.prfOutput || evaluation.credentialId !== session.credentialId) {
      if (evaluation.prfOutput) wipeBytes(evaluation.prfOutput);
      throw new HolderError('prf-unsupported', PRF_UNSUPPORTED_MESSAGE);
    }
    let envelope: WebIdentityEnvelope;
    try {
      envelope = sealAndReopen(ports, identity, { prfOutput: evaluation.prfOutput, credentialId: evaluation.credentialId, rpId: session.rpId });
    } finally {
      wipeBytes(evaluation.prfOutput);
    }
    const proof = await signIdentityProof(identity, {
      action: IDENTITY_PROOF_ACTIONS.establish,
      subject: session.account.userId,
      actor: session.account.userId,
      rootPublicKey: identity.publicKey,
      payloadDigest: digestIdentityPayload(envelope),
      expectedRevision: null,
      audience: challenge.audience,
      challenge: challenge.challenge,
      expiresAt: challenge.expiresAt,
    });
    let response: WebIdentityEnvelopeResponse;
    try {
      response = await ports.api.establishIdentity(envelope, proof, evaluation.response);
    } catch (error) {
      translateApiError(error);
    }
    session.account = { ...session.account, publicKey: identity.publicKey };
    await ports.local.write(session.account.userId, envelope);
    return { identity, status: statusFrom(response, session) };
  } catch (error) {
    wipeOpenedIdentity(identity);
    throw error;
  }
}

/**
 * Re-seal this account's root from its recovery material under the passkey that
 * signed in, replacing a web holder that no longer opens here. Records that the
 * material re-derived the root. The material must derive THIS account's root.
 */
export async function resealFromMaterial(ports: CarrierPorts, session: CarrierSession, material: WebIdentityRecoveryMaterial): Promise<IdentityStatus> {
  if (!session.account.publicKey) {
    const { identity, status } = await establishRoot(ports, session, material);
    wipeOpenedIdentity(identity);
    return status;
  }
  const identity = deriveIdentityFromRecoveryMaterial(material);
  try {
    if (identity.publicKey !== session.account.publicKey) {
      throw new HolderError('root-mismatch', 'This recovery phrase belongs to a different identity.');
    }
    let current: WebIdentityEnvelopeResponse;
    try {
      current = await ports.api.getEnvelope();
    } catch (error) {
      translateApiError(error);
    }
    if (!current.envelope) {
      const established = await establishRoot(ports, session, material);
      wipeOpenedIdentity(established.identity);
      return established.status;
    }
    const evaluation = await ports.passkeys.evaluatePrf({ rpId: session.rpId, credentialIds: [session.credentialId] });
    if (!evaluation.prfOutput || evaluation.credentialId !== session.credentialId) {
      if (evaluation.prfOutput) wipeBytes(evaluation.prfOutput);
      throw new HolderError('prf-unsupported', PRF_UNSUPPORTED_MESSAGE);
    }
    let envelope: WebIdentityEnvelope;
    try {
      envelope = sealAndReopen(ports, identity, { prfOutput: evaluation.prfOutput, credentialId: session.credentialId, rpId: session.rpId });
    } finally {
      wipeBytes(evaluation.prfOutput);
    }
    const expectedRevision = current.revision;
    try {
      const put = await proveForAccount(ports, session, identity, IDENTITY_PROOF_ACTIONS.put, { payload: envelope, expectedRevision });
      const stored = await ports.api.putEnvelope(envelope, { proof: put, expectedRevision });
      const revision = stored.revision;
      const verified = await proveForAccount(ports, session, identity, IDENTITY_PROOF_ACTIONS.recoveryVerified, { expectedRevision: revision });
      await ports.api.recoveryVerified({ proof: verified, expectedRevision: revision });
      const confirmed = await proveForAccount(ports, session, identity, IDENTITY_PROOF_ACTIONS.phraseConfirmed, { expectedRevision: revision });
      const final = await ports.api.confirmPhrase({ proof: confirmed, expectedRevision: revision });
      await ports.local.write(session.account.userId, envelope);
      return statusFrom(final, session);
    } catch (error) {
      if (error instanceof HolderError) throw error;
      translateApiError(error);
    }
  } finally {
    wipeOpenedIdentity(identity);
  }
}

/**
 * Signed-out recovery (ADR 0024 D5): no passkey, no session — the recovery
 * material alone. The root proves itself, a new passkey is created for the SAME
 * account, the root is sealed under it, and the API returns a normal session.
 */
export async function recoverSignedOut(ports: CarrierPorts, material: WebIdentityRecoveryMaterial): Promise<CarrierSession> {
  const identity = deriveIdentityFromRecoveryMaterial(material);
  try {
    const challenge = await ports.api.recoveryChallenge();
    const startProof = await signIdentityProof(identity, {
      action: IDENTITY_PROOF_ACTIONS.recoverStart,
      subject: `root:${identity.publicKey}`,
      actor: 'anonymous',
      rootPublicKey: identity.publicKey,
      payloadDigest: null,
      expectedRevision: null,
      audience: IDENTITY_PROOF_AUDIENCE,
      challenge: challenge.challenge,
      expiresAt: challenge.expiresAt,
    });
    const started = await ports.api.recoveryStart(identity.publicKey, startProof);
    const options = started.registrationOptions as unknown as CreationOptionsJSON;
    const created = await ports.passkeys.create(options);
    const prfOutput = await stablePrfOfNewPasskey(ports, created);
    try {
      const envelope = sealAndReopen(ports, identity, { prfOutput, credentialId: created.credentialId, rpId: created.rpId });
      const proof = await signIdentityProof(identity, {
        action: IDENTITY_PROOF_ACTIONS.recoverComplete,
        subject: started.accountId,
        actor: `credential:${created.credentialId}`,
        rootPublicKey: identity.publicKey,
        payloadDigest: digestIdentityPayload({ envelope }),
        expectedRevision: null,
        audience: IDENTITY_PROOF_AUDIENCE,
        challenge: hexOfBase64Url(options.challenge),
        expiresAt: nowOf(ports).getTime() + PROOF_LIFETIME_MS,
      });
      const account = await ports.api.recoveryComplete({ ticket: started.ticket, response: created.response, envelope, proof });
      await ports.local.write(account.userId, envelope);
      return { account, credentialId: created.credentialId, rpId: created.rpId };
    } finally {
      wipeBytes(prfOutput);
    }
  } finally {
    wipeOpenedIdentity(identity);
  }
}

/* -------------------------------------------------------------------------- */
/* Destructive operations                                                      */
/* -------------------------------------------------------------------------- */

/** Delete the account, proven with the root (`DELETE /users/me`). */
export async function deleteAccount(ports: CarrierPorts, session: CarrierSession, confirmText: string): Promise<void> {
  await withRoot(ports, session, async (identity) => {
    const timestamp = nowOf(ports).getTime();
    const signature = await signMessage(`delete:${identity.publicKey}:${timestamp}`, identity.privateKey);
    await ports.api.deleteAccount({ publicKey: identity.publicKey, signature, timestamp, confirmText });
  });
  await ports.local.remove(session.account.userId);
}

/* -------------------------------------------------------------------------- */
/* Adding Commons as a holder, optionally keeping only Commons                 */
/* -------------------------------------------------------------------------- */

/**
 * A transfer this browser started. The ephemeral private
 * key and the commitment nonce never leave memory until the reveal.
 */
export interface OutgoingMove {
  moveId: string;
  expiresAt: string;
  ephemeral: { privateKey: string; publicKey: string };
  commitment: string;
  commitmentNonce: string;
  /** Set when the root is sealed: the digest the receipt must bind. */
  ciphertextDigest?: string;
}

/** What the person sees while a transfer is under way. */
export type MoveProgress =
  /** Waiting for Commons to scan the code. */
  | { kind: 'waiting' }
  /** Commons joined: compare this code on both screens before sending. */
  | { kind: 'compare'; sas: string }
  /** Sent; waiting for Commons to confirm it holds the identity. */
  | { kind: 'sent' }
  /** Commons proved it holds the identity. */
  | { kind: 'received' }
  /** The transfer ended without the identity changing hands. */
  | { kind: 'ended'; reason: 'expired' | 'cancelled' };

/**
 * Start giving this account's root to Commons. The root is proven to open here
 * before a code is shown, so a person never scans a code that cannot complete.
 * Only a COMMITMENT to this browser's ephemeral key is published.
 */
export async function startMove(ports: CarrierPorts, session: CarrierSession): Promise<OutgoingMove> {
  await withRoot(ports, session, async (identity) => {
    if (identity.kind !== 'mnemonic') {
      throw new Error('This identity has no recovery phrase, so it can’t be added to Commons this way.');
    }
  });
  const ephemeral = generateMoveEphemeralKeyPair();
  const { commitment, nonce } = createMoveCommitment(ephemeral.publicKey);
  const { moveId, expiresAt } = await ports.api.createMove(commitment);
  return { moveId, expiresAt, ephemeral, commitment, commitmentNonce: nonce };
}

function verifyOwnMove(move: OutgoingMove, state: IdentityMoveState): void {
  if (
    state.moveId !== move.moveId ||
    state.initiatorCommitment !== move.commitment ||
    (state.initiatorEphemeralPublicKey !== null && state.initiatorEphemeralPublicKey !== move.ephemeral.publicKey)
  ) {
    throw new Error('The transfer could not be verified. Start again.');
  }
}

/**
 * Read where the transfer stands. Once Commons has joined, reveal this browser's
 * key — only then, so the relay has already committed to the key it forwarded
 * from Commons. A relay reporting another commitment or key is not showing us
 * our own transfer, and nothing is sealed to it.
 */
export async function readMove(ports: CarrierPorts, move: OutgoingMove): Promise<{ state: IdentityMoveState; progress: MoveProgress }> {
  let state = await ports.api.getMove(move.moveId);
  verifyOwnMove(move, state);
  if (state.status === 'joined' && state.initiatorEphemeralPublicKey === null) {
    if (!state.responderEphemeralPublicKey) throw new Error('The transfer could not be verified. Start again.');
    const responder = state.responderEphemeralPublicKey;
    state = await ports.api.revealMove(move.moveId, move.ephemeral.publicKey, move.commitmentNonce);
    verifyOwnMove(move, state);
    if (state.responderEphemeralPublicKey !== responder) throw new Error('The transfer could not be verified. Start again.');
  }
  switch (state.status) {
    case 'pending':
      return { state, progress: { kind: 'waiting' } };
    case 'joined':
      if (!state.responderEphemeralPublicKey || state.initiatorEphemeralPublicKey !== move.ephemeral.publicKey) {
        throw new Error('The transfer could not be verified. Start again.');
      }
      return {
        state,
        progress: {
          kind: 'compare',
          sas: deriveMoveSas({
            moveId: move.moveId,
            initiatorEphemeralPublicKey: move.ephemeral.publicKey,
            responderEphemeralPublicKey: state.responderEphemeralPublicKey,
            initiatorCommitment: move.commitment,
          }),
        },
      };
    case 'sealed':
      return { state, progress: { kind: 'sent' } };
    case 'completed':
      return { state, progress: { kind: 'received' } };
    default:
      return { state, progress: { kind: 'ended', reason: state.status === 'cancelled' ? 'cancelled' : 'expired' } };
  }
}

/**
 * The person confirmed both screens show the same code: seal the root for the
 * device that joined. The SAS is recomputed from the state being sealed to, so a
 * key swapped after the comparison cannot receive it.
 */
export async function sendMove(ports: CarrierPorts, session: CarrierSession, move: OutgoingMove, confirmedSas: string): Promise<void> {
  const { state, progress } = await readMove(ports, move);
  if (progress.kind !== 'compare' || progress.sas !== confirmedSas || !state.responderEphemeralPublicKey) {
    throw new Error('The code changed. Start again.');
  }
  const responderKey = state.responderEphemeralPublicKey;
  await withRoot(ports, session, async (identity) => {
    if (identity.publicKey !== state.publicKey) throw new Error('The transfer could not be verified. Start again.');
    if (identity.kind !== 'mnemonic') throw new Error('This identity has no recovery phrase, so it can’t be added to Commons this way.');
    const moveKey = deriveMoveKey(move.ephemeral.privateKey, responderKey, move.moveId);
    let sealed: { nonce: string; ciphertext: string };
    try {
      sealed = sealIdentityForMove(identity, moveKey, move.moveId);
    } finally {
      wipeBytes(moveKey);
    }
    // The seal is authorized by a one-use root proof over this move and these exact bytes.
    const proof = await proveForAccount(ports, session, identity, IDENTITY_PROOF_ACTIONS.moveSeal, { payload: buildMoveSealPayload(move.moveId, sealed) });
    await ports.api.sealMove(move.moveId, { ...sealed, proof });
    move.ciphertextDigest = digestMoveCiphertext(sealed);
  });
}

/**
 * Commons reports the root received. Its receipt is verified HERE against the
 * account's root, over this move, both keys and the ciphertext THIS browser
 * sealed — a server that claims completion without Commons holding the root, or
 * that relayed different bytes, cannot make this browser remove anything.
 *
 * `keepWebHolder` (ADR 0024 D6): adding Commons keeps the browser holder; only
 * "keep it only in Commons" removes it, and only after the receipt verified.
 */
export async function completeMove(
  ports: CarrierPorts,
  session: CarrierSession,
  move: OutgoingMove,
  state: IdentityMoveState,
  options: { keepWebHolder: boolean },
): Promise<void> {
  if (state.status !== 'completed' || state.receiptSignature === null || !state.responderEphemeralPublicKey) {
    throw new Error('The transfer is not complete yet');
  }
  const root = session.account.publicKey;
  if (!root || root !== state.publicKey || !move.ciphertextDigest) throw new Error('The transfer could not be verified. Start again.');
  const valid = await verifyMoveReceipt(
    {
      moveId: move.moveId,
      rootPublicKey: root,
      initiatorEphemeralPublicKey: move.ephemeral.publicKey,
      responderEphemeralPublicKey: state.responderEphemeralPublicKey,
      ciphertextDigest: move.ciphertextDigest,
    },
    state.receiptSignature,
  );
  if (!valid) throw new Error('Commons did not prove it received your identity. Nothing was removed here.');

  if (!options.keepWebHolder) {
    await withRoot(ports, session, async (identity, current) => {
      const expectedRevision = current.revision ?? 0;
      try {
        const proof = await proveForAccount(ports, session, identity, IDENTITY_PROOF_ACTIONS.delete, { expectedRevision });
        await ports.api.deleteEnvelope({ proof, expectedRevision });
      } catch (error) {
        if (error instanceof HolderError) throw error;
        translateApiError(error);
      }
    });
    await ports.local.remove(session.account.userId);
  }
  wipeMove(move);
}

/** Give up on a transfer before it completes. */
export async function cancelMove(ports: CarrierPorts, move: OutgoingMove): Promise<void> {
  try {
    await ports.api.cancelMove(move.moveId);
  } finally {
    wipeMove(move);
  }
}

function wipeMove(move: OutgoingMove): void {
  (move.ephemeral as { privateKey: string }).privateKey = '';
  move.commitmentNonce = '';
}

/** Best-effort removal of secret strings from an opened identity. */
export function wipeIdentity(identity: OpenedWebIdentity): void {
  wipeOpenedIdentity(identity);
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
