/**
 * The Oxy API as the identity origin uses it.
 *
 * A thin layer over `OxyServices` (bearer kept in memory only — this origin
 * persists no session, so every visit proves the person again with a passkey).
 * Every call the carrier makes is here, so the whole network surface of the
 * page that unseals identities can be read in one file.
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
  LoginResult,
  WebIdentityEnvelope,
  WebIdentityEnvelopeProof,
  WebIdentityEnvelopeResponse,
} from '@oxy.so/contracts';
import type { CreationOptionsJSON, RequestOptionsJSON } from './passkey';

/** The account a signed-in carrier session belongs to. */
export interface CarrierAccount {
  userId: string;
  username: string | null;
  /** The linked identity public key, lowercase, or `null` when none is linked. */
  publicKey: string | null;
  sessionId: string;
}

export interface IdentityApi {
  loginOptions(): Promise<RequestOptionsJSON>;
  loginVerify(response: Record<string, unknown>): Promise<CarrierAccount>;
  registerOptions(username: string): Promise<CreationOptionsJSON>;
  registerVerify(response: Record<string, unknown>, username: string): Promise<CarrierAccount>;
  isUsernameAvailable(username: string): Promise<boolean>;
  getEnvelope(): Promise<WebIdentityEnvelopeResponse>;
  putEnvelope(envelope: WebIdentityEnvelope, proof: WebIdentityEnvelopeProof): Promise<WebIdentityEnvelopeResponse>;
  /** Link an account's FIRST identity and store its envelope in one transaction. */
  establishIdentity(envelope: WebIdentityEnvelope, link: WebIdentityEnvelopeProof, put: WebIdentityEnvelopeProof): Promise<WebIdentityEnvelopeResponse>;
  confirmPhrase(proof: WebIdentityEnvelopeProof): Promise<WebIdentityEnvelopeResponse>;
  deleteEnvelope(proof: WebIdentityEnvelopeProof): Promise<void>;
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
      return resolveAccount(await oxy.webauthnLoginVerify(response, { deviceName: 'Oxy Identity' }));
    },
    async registerOptions(username) {
      return (await oxy.webauthnRegisterOptions(username)) as CreationOptionsJSON;
    },
    async registerVerify(response, username) {
      const result = await oxy.webauthnRegisterVerify(response, { username, deviceName: 'Oxy Identity' });
      if (!('sessionId' in result)) throw new Error('The account was not created');
      return resolveAccount(result);
    },
    async isUsernameAvailable(username) {
      return (await oxy.checkUsernameAvailability(username)).available;
    },
    getEnvelope() {
      return oxy.makeRequest<WebIdentityEnvelopeResponse>('GET', '/identity/web-envelope', undefined, { cache: false });
    },
    putEnvelope(envelope, proof) {
      return oxy.makeRequest<WebIdentityEnvelopeResponse>('PUT', '/identity/web-envelope', { envelope, ...proof }, { cache: false });
    },
    establishIdentity(envelope, link, put) {
      return oxy.makeRequest<WebIdentityEnvelopeResponse>('POST', '/identity/web-envelope/establish', { envelope, link, ...put }, { cache: false });
    },
    confirmPhrase(proof) {
      return oxy.makeRequest<WebIdentityEnvelopeResponse>('POST', '/identity/web-envelope/phrase-confirmed', proof, { cache: false });
    },
    async deleteEnvelope(proof) {
      await oxy.makeRequest('DELETE', '/identity/web-envelope', proof, { cache: false });
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
