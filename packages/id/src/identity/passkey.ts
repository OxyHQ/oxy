/**
 * Passkey ceremonies with the WebAuthn PRF extension.
 *
 * The Oxy API issues standard WebAuthn options (it knows nothing about PRF) and
 * verifies standard responses. This module adds the one thing the identity
 * carrier needs on top: the PRF evaluation of `WEB_IDENTITY_PRF_INPUT`, returned
 * alongside the response and never sent to the server.
 *
 * `navigator.credentials` is called directly rather than through
 * `@simplewebauthn/browser`'s `start*` helpers so the PRF input stays a
 * `BufferSource` and the PRF output is read before the response is serialized.
 *
 * User verification is always REQUIRED here: an authenticator derives a
 * different PRF secret with and without user verification (CTAP `hmac-secret`),
 * so a ceremony that silently skipped it would return a value that never opens
 * the envelope — and a key-unsealing prompt must prove the person anyway.
 */

import { base64URLStringToBuffer, bufferToBase64URLString } from '@simplewebauthn/browser';
import { WEB_IDENTITY_PRF_INPUT } from '@oxy.so/core';

/** A JSON-encoded public-key credential descriptor, as the API sends it. */
interface CredentialDescriptorJSON {
  id: string;
  type: 'public-key';
  transports?: AuthenticatorTransport[];
}

/** The subset of `PublicKeyCredentialCreationOptionsJSON` the API emits. */
export interface CreationOptionsJSON {
  challenge: string;
  rp: PublicKeyCredentialRpEntity;
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  excludeCredentials?: CredentialDescriptorJSON[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
}

/** The subset of `PublicKeyCredentialRequestOptionsJSON` the API emits. */
export interface RequestOptionsJSON {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: CredentialDescriptorJSON[];
  userVerification?: UserVerificationRequirement;
}

/** The outcome of a ceremony: the response for the server and the PRF output for the carrier. */
export interface CeremonyResult<ResponseJSON> {
  /** Serializable response to POST to the API's verify endpoint. */
  response: ResponseJSON;
  /** The credential id (base64url). */
  credentialId: string;
  /** The 32-byte PRF output, or `null` when the authenticator did not provide one. */
  prfOutput: Uint8Array | null;
}

const prfExtension = (): AuthenticationExtensionsClientInputs =>
  ({ prf: { eval: { first: WEB_IDENTITY_PRF_INPUT } } }) as AuthenticationExtensionsClientInputs;

function toDescriptor(descriptor: CredentialDescriptorJSON): PublicKeyCredentialDescriptor {
  return { id: base64URLStringToBuffer(descriptor.id), type: 'public-key', transports: descriptor.transports };
}

/** API creation options → browser options, with PRF requested and a discoverable, verified credential. */
export function toCreationOptions(json: CreationOptionsJSON): PublicKeyCredentialCreationOptions {
  return {
    challenge: base64URLStringToBuffer(json.challenge),
    rp: json.rp,
    user: { ...json.user, id: base64URLStringToBuffer(json.user.id) },
    pubKeyCredParams: json.pubKeyCredParams,
    timeout: json.timeout,
    excludeCredentials: json.excludeCredentials?.map(toDescriptor),
    attestation: json.attestation ?? 'none',
    authenticatorSelection: {
      ...json.authenticatorSelection,
      // Discoverable, so the next visit needs no username; verified, so PRF is stable.
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    extensions: prfExtension(),
  };
}

/** API request options → browser options, with PRF requested and user verification required. */
export function toRequestOptions(json: RequestOptionsJSON): PublicKeyCredentialRequestOptions {
  return {
    challenge: base64URLStringToBuffer(json.challenge),
    timeout: json.timeout,
    rpId: json.rpId,
    allowCredentials: json.allowCredentials?.map(toDescriptor),
    userVerification: 'required',
    extensions: prfExtension(),
  };
}

/**
 * The PRF output from a credential's extension results, or `null`.
 *
 * `prf.enabled` alone is not trusted (some providers report support and return
 * nothing): only an actual 32-byte `results.first` counts.
 */
export function readPrfOutput(extensions: AuthenticationExtensionsClientOutputs): Uint8Array | null {
  const first = (extensions as { prf?: { results?: { first?: BufferSource } } }).prf?.results?.first;
  if (!first) return null;
  const bytes = first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  return bytes.byteLength === 32 ? new Uint8Array(bytes) : null;
}

type AttestationResponse = AuthenticatorAttestationResponse & {
  getTransports?: () => string[];
};

/** A registration credential → the `RegistrationResponseJSON` the API verifies. */
export function registrationToJSON(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AttestationResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64URLString(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64URLString(response.clientDataJSON),
      attestationObject: bufferToBase64URLString(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
    clientExtensionResults: {},
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

/** An assertion credential → the `AuthenticationResponseJSON` the API verifies. */
export function authenticationToJSON(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64URLString(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64URLString(response.clientDataJSON),
      authenticatorData: bufferToBase64URLString(response.authenticatorData),
      signature: bufferToBase64URLString(response.signature),
      userHandle: response.userHandle ? bufferToBase64URLString(response.userHandle) : undefined,
    },
    clientExtensionResults: {},
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

/** Whether this browser can run a passkey ceremony at all. */
export function supportsPasskeys(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;
}

/** Create a passkey, requesting PRF. */
export async function createPasskey(options: CreationOptionsJSON): Promise<CeremonyResult<Record<string, unknown>>> {
  const credential = (await navigator.credentials.create({ publicKey: toCreationOptions(options) })) as PublicKeyCredential | null;
  if (!credential) throw new Error('The passkey was not created');
  return {
    response: registrationToJSON(credential),
    credentialId: credential.id,
    prfOutput: readPrfOutput(credential.getClientExtensionResults()),
  };
}

/** Sign in with a passkey, requesting PRF from the same ceremony. */
export async function assertPasskey(options: RequestOptionsJSON): Promise<CeremonyResult<Record<string, unknown>>> {
  const credential = (await navigator.credentials.get({ publicKey: toRequestOptions(options) })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was used');
  return {
    response: authenticationToJSON(credential),
    credentialId: credential.id,
    prfOutput: readPrfOutput(credential.getClientExtensionResults()),
  };
}

/**
 * Evaluate PRF for one known credential WITHOUT a server round trip.
 *
 * The PRF output does not depend on the challenge, so a locally random one is
 * enough — used right after registration when the authenticator returned no PRF
 * output at `create()` time (common). Nothing from this ceremony is sent anywhere.
 */
export async function evaluatePrf(credentialId: string): Promise<Uint8Array | null> {
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ id: base64URLStringToBuffer(credentialId), type: 'public-key' }],
      userVerification: 'required',
      extensions: prfExtension(),
    },
  })) as PublicKeyCredential | null;
  return credential ? readPrfOutput(credential.getClientExtensionResults()) : null;
}
