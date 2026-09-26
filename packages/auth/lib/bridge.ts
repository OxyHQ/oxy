/**
 * auth.oxy.so/bridge — how an official Oxy web app joins the browser's ONE
 * DeviceSession (ADR 0029 D2).
 *
 * Different domains share no storage, so the browser's Oxy session lives here,
 * on auth.oxy.so. An app that holds no device credential opens this page from a
 * sign-in press (never on load). It has no UI and closes in well under a second:
 *
 *  1. read `client_id`, `redirect_uri`, `state`, `code_challenge` from the query;
 *  2. load auth.oxy.so's own device credential — the SAME store and key this
 *     origin's `OxyProvider` uses, so this page and auth.oxy.so's own sign-ins
 *     share one device — or register a new, empty device when there is none
 *     (or the stored one answers `invalid_device_secret`) and save it;
 *  3. ask the API for a one-use join code bound to the app, its exact registered
 *     redirect URI and its PKCE challenge;
 *  4. post `{ type, code, state }` to `window.opener`, with the redirect URI's
 *     origin as the target — never `*` — and close. Any failure posts an error
 *     message instead, and closes.
 *
 * SECURITY: the code is useless without the app's PKCE verifier, is bound to one
 * official application and one exact redirect URI (the API refuses anything else
 * when issuing it), lives about a minute and is spent on first use. The only
 * values that cross the window boundary are that code, the `state` echo and an
 * error code — never the device secret.
 *
 * Deliberately free of React and of `@oxy.so/core`'s barrel: every dependency is
 * injected, so the entry (`src/bridge.ts`) stays a few KB and this stays testable.
 */

/** Message type carrying a join code. */
export const BRIDGE_CODE_MESSAGE_TYPE = "oxy:bridge:code"
/** Message type carrying a failure. */
export const BRIDGE_ERROR_MESSAGE_TYPE = "oxy:bridge:error"

export interface BridgeCodeMessage {
  type: typeof BRIDGE_CODE_MESSAGE_TYPE
  code: string
  state: string
}

export interface BridgeErrorMessage {
  type: typeof BRIDGE_ERROR_MESSAGE_TYPE
  error: string
  state: string
}

export type BridgeMessage = BridgeCodeMessage | BridgeErrorMessage

/** A validated bridge request. */
export interface BridgeRequest {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  /** The redirect URI's origin — the ONLY window the result is posted to. */
  targetOrigin: string
}

const PKCE_S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/

/**
 * Parse the query. `null` when anything is missing or malformed — including a
 * redirect URI without a web origin, which could never be a message target.
 */
export function parseBridgeRequest(search: string): BridgeRequest | null {
  const params = new URLSearchParams(search)
  const clientId = params.get("client_id")
  const redirectUri = params.get("redirect_uri")
  const state = params.get("state")
  const codeChallenge = params.get("code_challenge")
  const method = params.get("code_challenge_method") ?? "S256"
  if (!clientId || !redirectUri || !state || !codeChallenge) return null
  if (method !== "S256" || !PKCE_S256_CHALLENGE.test(codeChallenge)) return null
  let targetOrigin: string
  try {
    const url = new URL(redirectUri)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    targetOrigin = url.origin
  } catch {
    return null
  }
  return { clientId, redirectUri, state, codeChallenge, targetOrigin }
}

/** A failed API call: its HTTP status and the API's `error` code, when any. */
export class BridgeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(code ?? `HTTP ${status}`)
    this.name = "BridgeApiError"
  }
}

export interface DeviceCredential {
  deviceId: string
  deviceSecret: string
}

/** The slice of core's `AuthStateStore` the bridge uses. */
export interface BridgeCredentialStore {
  load(): Promise<{ deviceId?: string; deviceSecret?: string } | null>
  save(state: { sessionId: string; userId: string; deviceId: string; deviceSecret: string }): Promise<boolean>
}

export interface BridgeDeps {
  store: BridgeCredentialStore
  registerDevice(): Promise<DeviceCredential>
  requestJoinCode(input: DeviceCredential & {
    clientId: string
    redirectUri: string
    codeChallenge: string
    codeChallengeMethod: "S256"
  }): Promise<{ code: string }>
}

async function registerAndSave(deps: BridgeDeps): Promise<DeviceCredential> {
  const credential = await deps.registerDevice()
  // A device-only state: nobody is signed in on it yet. auth.oxy.so's own
  // provider restores from it like any other holder.
  await deps.store.save({ sessionId: "", userId: "", ...credential })
  return credential
}

/**
 * auth.oxy.so's credential → a join code for the requesting app. A stored
 * credential the API no longer recognises (its device ended with nobody signed
 * in) is replaced by a newly registered device, once.
 */
export async function obtainJoinCode(deps: BridgeDeps, request: BridgeRequest): Promise<string> {
  const stored = await deps.store.load()
  let credential: DeviceCredential =
    stored?.deviceId && stored.deviceSecret
      ? { deviceId: stored.deviceId, deviceSecret: stored.deviceSecret }
      : await registerAndSave(deps)
  const ask = () =>
    deps.requestJoinCode({
      ...credential,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: "S256",
    })
  try {
    return (await ask()).code
  } catch (error) {
    if (!(error instanceof BridgeApiError) || error.code !== "invalid_device_secret") throw error
    credential = await registerAndSave(deps)
    return (await ask()).code
  }
}

/** The message for the opener: a code, or an error code. Never throws. */
export async function runBridge(deps: BridgeDeps, request: BridgeRequest): Promise<BridgeMessage> {
  try {
    const code = await obtainJoinCode(deps, request)
    return { type: BRIDGE_CODE_MESSAGE_TYPE, code, state: request.state }
  } catch (error) {
    const code = error instanceof BridgeApiError && error.code ? error.code : "bridge_failed"
    return { type: BRIDGE_ERROR_MESSAGE_TYPE, error: code, state: request.state }
  }
}

/** The opener surface a message is posted to. */
export interface BridgeOpener {
  postMessage(message: BridgeMessage, targetOrigin: string): void
}

/**
 * Post to the opener, targeted at the redirect URI's exact origin. Returns
 * whether it was posted (no opener, or it threw, is `false`).
 */
export function deliverBridgeMessage(
  opener: BridgeOpener | null | undefined,
  message: BridgeMessage,
  targetOrigin: string,
): boolean {
  if (!opener || !targetOrigin || targetOrigin === "null" || targetOrigin === "*") return false
  try {
    opener.postMessage(message, targetOrigin)
    return true
  } catch {
    return false
  }
}

/**
 * The API half, over plain `fetch`: every bridge route answers `{ data }` on
 * success and `{ error }` on failure.
 */
export function createBridgeApi(apiBaseUrl: string, fetchImpl: typeof fetch = fetch) {
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetchImpl(`${apiBaseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    })
    let json: { data?: T; error?: unknown } | null = null
    try {
      json = (await response.json()) as { data?: T; error?: unknown }
    } catch {
      json = null
    }
    if (!response.ok || !json?.data) {
      throw new BridgeApiError(response.status, typeof json?.error === "string" ? json.error : null)
    }
    return json.data
  }
  return {
    registerDevice: () => post<DeviceCredential>("/session/device/register", {}),
    requestJoinCode: (input: Parameters<BridgeDeps["requestJoinCode"]>[0]) =>
      post<{ code: string }>("/session/device/join-code", input),
  }
}
