/**
 * Passkey ceremonies — authentication, and the WebAuthn PRF evaluation only a
 * ROOT OPERATION asks for (ADR 0024 D3).
 *
 * The Oxy API issues standard WebAuthn options (it knows nothing about PRF) and
 * verifies standard responses. Two things are added here:
 *
 * - **Sign-in never requests PRF.** Authenticating proves who the person is; it
 *   does not unseal anything. A PRF output is requested only by a ceremony whose
 *   purpose is to create, open or re-wrap the root.
 * - **The RP ID is always explicit.** A credential lives under the RP ID it was
 *   created with; every follow-up ceremony names it rather than trusting the
 *   browser's default for whatever origin runs the page (ADR 0024 D2).
 *
 * User verification is REQUIRED on every PRF ceremony: an authenticator derives a
 * different PRF secret with and without it (CTAP `hmac-secret`), so a ceremony
 * that silently skipped it would return a value that never opens the envelope.
 *
 * Only an actual 32-byte PRF result counts. `prf.enabled` alone, or a
 * `PublicKeyCredential` that exists, is not support.
 */

import { base64UrlToBuffer, bufferToBase64Url } from './base64url';
import { WEB_IDENTITY_PRF_INPUT, isUsablePrfOutput } from '@oxy.so/core';

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

/** A created passkey: the response for the server, and PRF if the authenticator gave it at `create()`. */
export interface CreatedPasskey {
  response: Record<string, unknown>;
  credentialId: string;
  /** The RP ID the credential was created under. */
  rpId: string;
  /** A usable PRF output, or `null` — many authenticators return none at creation. */
  prfOutput: Uint8Array | null;
}

/** A sign-in assertion. No PRF, by construction. */
export interface Assertion {
  response: Record<string, unknown>;
  credentialId: string;
}

/** A root ceremony: which credential answered, its PRF output, and the assertion (usable as a fresh factor). */
export interface PrfEvaluation {
  credentialId: string;
  prfOutput: Uint8Array | null;
  response: Record<string, unknown>;
}

/** The credentials a root ceremony may use: every wrap, grouped under the RP ID they live in. */
export interface PrfRequest {
  rpId: string;
  /** Allowed credential ids. Empty = discoverable. */
  credentialIds: string[];
  /** The challenge bytes, hex. A server proof challenge when the assertion must count as a fresh factor. */
  challengeHex?: string;
}

const prfExtension = (): AuthenticationExtensionsClientInputs =>
  ({ prf: { eval: { first: WEB_IDENTITY_PRF_INPUT } } }) as AuthenticationExtensionsClientInputs;

function toDescriptor(descriptor: CredentialDescriptorJSON): PublicKeyCredentialDescriptor {
  return { id: base64UrlToBuffer(descriptor.id), type: 'public-key', transports: descriptor.transports };
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/** The RP ID a creation ceremony runs under: the one the API named, else this page's host. */
export function rpIdOf(options: CreationOptionsJSON): string {
  return options.rp.id ?? window.location.hostname;
}

/** API creation options → browser options: discoverable, verified, PRF requested (the root is sealed under it). */
export function toCreationOptions(json: CreationOptionsJSON): PublicKeyCredentialCreationOptions {
  return {
    challenge: base64UrlToBuffer(json.challenge),
    rp: { ...json.rp, id: rpIdOf(json) },
    user: { ...json.user, id: base64UrlToBuffer(json.user.id) },
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

/** API request options → browser options for SIGN-IN: no PRF extension at all. */
export function toSignInOptions(json: RequestOptionsJSON): PublicKeyCredentialRequestOptions {
  return {
    challenge: base64UrlToBuffer(json.challenge),
    timeout: json.timeout,
    rpId: json.rpId,
    allowCredentials: json.allowCredentials?.map(toDescriptor),
    userVerification: json.userVerification ?? 'preferred',
  };
}

/** A root ceremony's browser options: explicit RP ID, the wraps' credentials, UV required, PRF requested. */
export function toPrfOptions(request: PrfRequest): PublicKeyCredentialRequestOptions {
  let challenge: Uint8Array<ArrayBuffer>;
  if (request.challengeHex) {
    challenge = hexToBytes(request.challengeHex);
  } else {
    // Unlocking alone needs no server: the PRF output does not depend on the challenge.
    challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
  }
  return {
    challenge,
    rpId: request.rpId,
    allowCredentials: request.credentialIds.map((id) => ({ id: base64UrlToBuffer(id), type: 'public-key' })),
    userVerification: 'required',
    extensions: prfExtension(),
  };
}

/** The PRF output from a credential's extension results — only an actual 32-byte value, else `null`. */
export function readPrfOutput(extensions: AuthenticationExtensionsClientOutputs): Uint8Array | null {
  const first = (extensions as { prf?: { results?: { first?: BufferSource } } }).prf?.results?.first;
  if (!first) return null;
  const bytes = first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  const copy = new Uint8Array(bytes);
  return isUsablePrfOutput(copy) ? copy : null;
}

type AttestationResponse = AuthenticatorAttestationResponse & {
  getTransports?: () => string[];
};

/**
 * A registration credential → the `RegistrationResponseJSON` the API verifies.
 * `clientExtensionResults` is always empty: a PRF output is never serialized.
 */
export function registrationToJSON(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AttestationResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
    clientExtensionResults: {},
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

/**
 * An assertion credential → the `AuthenticationResponseJSON` the API verifies.
 * `clientExtensionResults` is always empty: a PRF output is never serialized.
 */
export function authenticationToJSON(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : undefined,
    },
    clientExtensionResults: {},
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

/** Whether this browser can run a passkey ceremony at all. */
export function supportsPasskeys(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;
}

/** Create a passkey, requesting PRF so a root can be sealed under it. */
export async function createPasskey(options: CreationOptionsJSON): Promise<CreatedPasskey> {
  const credential = (await navigator.credentials.create({ publicKey: toCreationOptions(options) })) as PublicKeyCredential | null;
  if (!credential) throw new Error('The passkey was not created');
  return {
    response: registrationToJSON(credential),
    credentialId: credential.id,
    rpId: rpIdOf(options),
    prfOutput: readPrfOutput(credential.getClientExtensionResults()),
  };
}

/** Sign in with a passkey. Authentication only — the root stays sealed. */
export async function assertPasskey(options: RequestOptionsJSON): Promise<Assertion> {
  const credential = (await navigator.credentials.get({ publicKey: toSignInOptions(options) })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was used');
  return { response: authenticationToJSON(credential), credentialId: credential.id };
}

/**
 * A root ceremony: evaluate PRF on one of the given credentials, under their RP
 * ID. Returns which credential answered, its PRF output (or `null`), and the
 * assertion — which the API accepts as a fresh factor when `challengeHex` was a
 * server proof challenge. The PRF output is never sent anywhere.
 */
export async function evaluatePrf(request: PrfRequest): Promise<PrfEvaluation> {
  const credential = (await navigator.credentials.get({ publicKey: toPrfOptions(request) })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was used');
  return {
    credentialId: credential.id,
    prfOutput: readPrfOutput(credential.getClientExtensionResults()),
    response: authenticationToJSON(credential),
  };
}
