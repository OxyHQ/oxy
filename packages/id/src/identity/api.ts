/**
 * The Oxy API as the holder host uses it.
 *
 * A thin layer over `OxyServices` (bearer kept in memory only — this origin
 * persists no session, so every visit proves the person again with a passkey).
 * Every call the holder makes is here, so the whole network surface of the page
 * that unseals roots can be read in one file.
 */

import {
  OxyServices,
  getCommonsApprovalBlockingReason,
  type CommonsApprovalInfo,
  type User,
} from '@oxy.so/core';
import type {
  IdentityMoveCreateResponse,
  IdentityMoveSealRequest,
  IdentityMoveState,
  IdentityProof,
  IdentityProofAction,
  IdentityProofChallengeResponse,
  IdentityRecoveryChallengeResponse,
  IdentityRecoveryStartResponse,
  LoginResult,
  WebIdentityEnvelope,
  WebIdentityEnvelopeResponse,
} from '@oxy.so/contracts';
import type { CreationOptionsJSON, RequestOptionsJSON } from './passkey';

/** The account a signed-in holder session belongs to. */
export interface CarrierAccount {
  userId: string;
  username: string | null;
  /** The linked root public key, lowercase, or `null` when none is linked. */
  publicKey: string | null;
  sessionId: string;
}

/** A root proof plus the revision a holder write expects to replace. */
export interface RevisionProof {
  proof: IdentityProof;
  expectedRevision: number;
}

/** Whether an error came back from the API (it has an HTTP status) rather than from the network. */
export function httpStatusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status > 0 ? status : null;
}

/** The stable API error code (`IDENTITY_*`), when the API sent one. */
export function errorCodeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

export interface IdentityApi {
  loginOptions(): Promise<RequestOptionsJSON>;
  loginVerify(response: Record<string, unknown>): Promise<CarrierAccount>;
  registerOptions(username: string): Promise<CreationOptionsJSON>;
  /** Create the account WITH its root (ADR 0024 D4). */
  registerVerify(
    response: Record<string, unknown>,
    username: string,
    identity: { envelope: WebIdentityEnvelope; proof: IdentityProof },
  ): Promise<CarrierAccount>;
  isUsernameAvailable(username: string): Promise<boolean>;
  proofChallenge(action: IdentityProofAction): Promise<IdentityProofChallengeResponse>;
  getEnvelope(): Promise<WebIdentityEnvelopeResponse>;
  putEnvelope(envelope: WebIdentityEnvelope, proof: RevisionProof): Promise<WebIdentityEnvelopeResponse>;
  /** Link a keyless account's FIRST root and store its envelope in one transaction. */
  establishIdentity(envelope: WebIdentityEnvelope, proof: IdentityProof, assertion: Record<string, unknown>): Promise<WebIdentityEnvelopeResponse>;
  confirmPhrase(proof: RevisionProof): Promise<WebIdentityEnvelopeResponse>;
  recoveryVerified(proof: RevisionProof): Promise<WebIdentityEnvelopeResponse>;
  deleteEnvelope(proof: RevisionProof): Promise<void>;
  recoveryChallenge(): Promise<IdentityRecoveryChallengeResponse>;
  recoveryStart(publicKey: string, proof: IdentityProof): Promise<IdentityRecoveryStartResponse>;
  recoveryComplete(input: {
    ticket: string;
    response: Record<string, unknown>;
    envelope: WebIdentityEnvelope;
    proof: IdentityProof;
  }): Promise<CarrierAccount>;
  createMove(initiatorEphemeralPublicKey: string): Promise<IdentityMoveCreateResponse>;
  getMove(moveId: string): Promise<IdentityMoveState>;
  sealMove(moveId: string, body: IdentityMoveSealRequest): Promise<IdentityMoveState>;
  cancelMove(moveId: string): Promise<void>;
  approvalInfo(code: string): Promise<{ info: CommonsApprovalInfo; blockingReason: string | null }>;
  authorizeCode(code: string): Promise<void>;
  denyCode(code: string): Promise<void>;
  deleteAccount(input: { publicKey: string; signature: string; timestamp: number; confirmText: string }): Promise<void>;
  signOut(sessionId: string): Promise<void>;
}

const DEVICE_NAME = 'Oxy';

function accountFrom(result: LoginResult, user: User): CarrierAccount {
  const publicKey = typeof user.publicKey === 'string' && user.publicKey.trim() ? user.publicKey.trim().toLowerCase() : null;
  return { userId: user.id, username: user.username ?? null, publicKey, sessionId: result.sessionId };
}

export function createIdentityApi(baseURL: string): IdentityApi {
  const oxy = new OxyServices({ baseURL, enableCache: false });

  async function resolveAccount(result: LoginResult): Promise<CarrierAccount> {
    // The session user carries `publicKey`; `/users/me` deliberately does not.
    return accountFrom(result, await oxy.getUserBySession(result.sessionId));
  }

  return {
    async loginOptions() {
      return (await oxy.webauthnLoginOptions()) as RequestOptionsJSON;
    },
    async loginVerify(response) {
      return resolveAccount(await oxy.webauthnLoginVerify(response, { deviceName: DEVICE_NAME }));
    },
    async registerOptions(username) {
      return (await oxy.webauthnRegisterOptions(username)) as CreationOptionsJSON;
    },
    async registerVerify(response, username, identity) {
      const result = await oxy.webauthnRegisterVerify(response, { username, deviceName: DEVICE_NAME, identity });
      if (!('sessionId' in result)) throw new Error('The account was not created');
      return resolveAccount(result);
    },
    async isUsernameAvailable(username) {
      return (await oxy.checkUsernameAvailability(username)).available;
    },
    proofChallenge(action) {
      return oxy.makeRequest<IdentityProofChallengeResponse>('POST', '/identity/proof-challenge', { action }, { cache: false });
    },
    getEnvelope() {
      return oxy.makeRequest<WebIdentityEnvelopeResponse>('GET', '/identity/web-envelope', undefined, { cache: false });
    },
    putEnvelope(envelope, { proof, expectedRevision }) {
      return oxy.makeRequest<WebIdentityEnvelopeResponse>('PUT', '/identity/web-envelope', { envelope, expectedRevision, proof }, { cache: false });
    },
    establishIdentity(envelope, proof, assertion) {
      return oxy.makeRequest<WebIdentityEnvelopeResponse>('POST', '/identity/web-envelope/establish', { envelope, proof, assertion }, { cache: false });
    },
    confirmPhrase(body) {
      return oxy.makeRequest<WebIdentityEnvelopeResponse>('POST', '/identity/web-envelope/phrase-confirmed', body, { cache: false });
    },
    recoveryVerified(body) {
      return oxy.makeRequest<WebIdentityEnvelopeResponse>('POST', '/identity/web-envelope/recovery-verified', body, { cache: false });
    },
    async deleteEnvelope(body) {
      await oxy.makeRequest('DELETE', '/identity/web-envelope', body, { cache: false });
    },
    recoveryChallenge() {
      return oxy.makeRequest<IdentityRecoveryChallengeResponse>('POST', '/identity/recovery/challenge', {}, { cache: false, skipAuth: true });
    },
    recoveryStart(publicKey, proof) {
      return oxy.makeRequest<IdentityRecoveryStartResponse>('POST', '/identity/recovery/start', { publicKey, proof }, { cache: false, skipAuth: true });
    },
    async recoveryComplete(input) {
      const result = await oxy.makeRequest<LoginResult>(
        'POST',
        '/identity/recovery/complete',
        { ...input, deviceName: DEVICE_NAME },
        { cache: false, skipAuth: true },
      );
      if (!result || typeof result.sessionId !== 'string' || typeof result.accessToken !== 'string') {
        throw new Error('The account could not be recovered');
      }
      oxy.setTokens(result.accessToken);
      return resolveAccount(result);
    },
    createMove(initiatorEphemeralPublicKey) {
      return oxy.makeRequest<IdentityMoveCreateResponse>('POST', '/identity/move', { initiatorEphemeralPublicKey }, { cache: false });
    },
    getMove(moveId) {
      return oxy.makeRequest<IdentityMoveState>('GET', `/identity/move/${encodeURIComponent(moveId)}`, undefined, { cache: false });
    },
    sealMove(moveId, body) {
      return oxy.makeRequest<IdentityMoveState>('POST', `/identity/move/${encodeURIComponent(moveId)}/seal`, body, { cache: false });
    },
    async cancelMove(moveId) {
      await oxy.makeRequest('DELETE', `/identity/move/${encodeURIComponent(moveId)}`, undefined, { cache: false });
    },
    async approvalInfo(code) {
      const info = await oxy.getCommonsApprovalInfo(code);
      return { info, blockingReason: getCommonsApprovalBlockingReason(info) };
    },
    async authorizeCode(code) {
      await oxy.makeRequest('POST', `/auth/session/authorize-code/${encodeURIComponent(code)}`, {}, { cache: false });
    },
    async denyCode(code) {
      await oxy.denyCommonsSignIn(code);
    },
    async deleteAccount({ signature, timestamp, confirmText }) {
      await oxy.makeRequest('DELETE', '/users/me', { signature, timestamp, confirmText }, { cache: false });
    },
    async signOut(sessionId) {
      await oxy.makeRequest('POST', `/session/logout/${encodeURIComponent(sessionId)}`, undefined, { cache: false });
      oxy.clearTokens();
    },
  };
}
