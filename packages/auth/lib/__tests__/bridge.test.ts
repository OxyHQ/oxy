/**
 * auth.oxy.so/bridge (ADR 0029 D2): the query it accepts, the device it proves or
 * registers, and the one message it posts — only to the app's own origin.
 */
import { describe, expect, it, mock } from "bun:test"
import {
  BRIDGE_CODE_MESSAGE_TYPE,
  BRIDGE_ERROR_MESSAGE_TYPE,
  BridgeApiError,
  createBridgeApi,
  deliverBridgeMessage,
  parseBridgeRequest,
  runBridge,
  type BridgeDeps,
  type BridgeRequest,
} from "../bridge"

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
const QUERY = `?client_id=oxy_dk_1&redirect_uri=${encodeURIComponent("https://mention.earth/")}&state=st-1&code_challenge=${CHALLENGE}&code_challenge_method=S256`

function memoryStore(initial: { deviceId?: string; deviceSecret?: string } | null = null) {
  let state: { deviceId?: string; deviceSecret?: string; sessionId?: string; userId?: string } | null = initial
  return {
    load: async () => state,
    save: async (next: { sessionId: string; userId: string; deviceId: string; deviceSecret: string }) => {
      state = next
      return true
    },
    current: () => state,
  }
}

const REQUEST = parseBridgeRequest(QUERY) as BridgeRequest

describe("parseBridgeRequest", () => {
  it("accepts a complete S256 request and targets the redirect URI's origin", () => {
    expect(REQUEST).toEqual({
      clientId: "oxy_dk_1",
      redirectUri: "https://mention.earth/",
      state: "st-1",
      codeChallenge: CHALLENGE,
      targetOrigin: "https://mention.earth",
    })
  })

  it("refuses anything incomplete, plain, or without a web origin", () => {
    expect(parseBridgeRequest(QUERY.replace("client_id=oxy_dk_1&", ""))).toBeNull()
    expect(parseBridgeRequest(QUERY.replace("S256", "plain"))).toBeNull()
    expect(parseBridgeRequest(QUERY.replace(CHALLENGE, "short"))).toBeNull()
    expect(parseBridgeRequest(QUERY.replace(encodeURIComponent("https://mention.earth/"), "mention%3A%2F%2Fcallback"))).toBeNull()
    expect(parseBridgeRequest(QUERY.replace("state=st-1&", ""))).toBeNull()
  })
})

describe("runBridge", () => {
  it("proves auth.oxy.so's stored device", async () => {
    const store = memoryStore({ deviceId: "dev-1", deviceSecret: "auth-secret" })
    const registerDevice = mock(async () => ({ deviceId: "never", deviceSecret: "never" }))
    const requestJoinCode = mock(async () => ({ code: "code-1" }))
    const message = await runBridge({ store, registerDevice, requestJoinCode }, REQUEST)
    expect(message).toEqual({ type: BRIDGE_CODE_MESSAGE_TYPE, code: "code-1", state: "st-1" })
    expect(registerDevice).not.toHaveBeenCalled()
    expect(requestJoinCode).toHaveBeenCalledWith({
      deviceId: "dev-1",
      deviceSecret: "auth-secret",
      clientId: "oxy_dk_1",
      redirectUri: "https://mention.earth/",
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
    })
  })

  it("registers and saves a device when auth.oxy.so holds none", async () => {
    const store = memoryStore()
    const deps: BridgeDeps = {
      store,
      registerDevice: async () => ({ deviceId: "dev-new", deviceSecret: "new-secret" }),
      requestJoinCode: async (input) => ({ code: `code-for-${input.deviceId}` }),
    }
    expect(await runBridge(deps, REQUEST)).toEqual({ type: BRIDGE_CODE_MESSAGE_TYPE, code: "code-for-dev-new", state: "st-1" })
    expect(store.current()).toEqual({ sessionId: "", userId: "", deviceId: "dev-new", deviceSecret: "new-secret" })
  })

  it("replaces a credential the API no longer knows, once", async () => {
    const store = memoryStore({ deviceId: "dev-dead", deviceSecret: "dead" })
    const requestJoinCode = mock(async (input: { deviceId: string }) => {
      if (input.deviceId === "dev-dead") throw new BridgeApiError(401, "invalid_device_secret")
      return { code: "code-2" }
    })
    const message = await runBridge(
      { store, registerDevice: async () => ({ deviceId: "dev-new", deviceSecret: "s" }), requestJoinCode },
      REQUEST,
    )
    expect(message).toEqual({ type: BRIDGE_CODE_MESSAGE_TYPE, code: "code-2", state: "st-1" })
    expect(requestJoinCode).toHaveBeenCalledTimes(2)
    expect(store.current()?.deviceId).toBe("dev-new")
  })

  it("answers an error code on any other failure", async () => {
    const store = memoryStore({ deviceId: "dev-1", deviceSecret: "s" })
    const message = await runBridge(
      {
        store,
        registerDevice: async () => ({ deviceId: "x", deviceSecret: "x" }),
        requestJoinCode: async () => {
          throw new BridgeApiError(400, "invalid_client")
        },
      },
      REQUEST,
    )
    expect(message).toEqual({ type: BRIDGE_ERROR_MESSAGE_TYPE, error: "invalid_client", state: "st-1" })
    expect(
      await runBridge(
        {
          store,
          registerDevice: async () => ({ deviceId: "x", deviceSecret: "x" }),
          requestJoinCode: async () => {
            throw new TypeError("Failed to fetch")
          },
        },
        REQUEST,
      ),
    ).toEqual({ type: BRIDGE_ERROR_MESSAGE_TYPE, error: "bridge_failed", state: "st-1" })
  })
})

describe("deliverBridgeMessage", () => {
  const message = { type: BRIDGE_CODE_MESSAGE_TYPE, code: "c", state: "s" } as const

  it("posts only to the named origin, never to *", () => {
    const postMessage = mock(() => undefined)
    expect(deliverBridgeMessage({ postMessage }, message, "https://mention.earth")).toBe(true)
    expect(postMessage).toHaveBeenCalledWith(message, "https://mention.earth")
    expect(deliverBridgeMessage({ postMessage }, message, "*")).toBe(false)
    expect(deliverBridgeMessage({ postMessage }, message, "null")).toBe(false)
    expect(deliverBridgeMessage(null, message, "https://mention.earth")).toBe(false)
    expect(postMessage).toHaveBeenCalledTimes(1)
  })
})

describe("createBridgeApi", () => {
  it("posts JSON without credentials and unwraps { data }", async () => {
    const fetchImpl = mock(async () => new Response(JSON.stringify({ data: { code: "c1", expiresIn: 60 } }), { status: 200 }))
    const api = createBridgeApi("https://api.oxy.so/", fetchImpl as unknown as typeof fetch)
    expect(
      await api.requestJoinCode({
        deviceId: "d",
        deviceSecret: "s",
        clientId: "c",
        redirectUri: "https://a.example",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
      }),
    ).toEqual({ code: "c1", expiresIn: 60 } as never)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://api.oxy.so/session/device/join-code")
    expect(init.credentials).toBe("omit")
  })

  it("surfaces the API's error code", async () => {
    const fetchImpl = mock(async () => new Response(JSON.stringify({ error: "invalid_device_secret" }), { status: 401 }))
    const api = createBridgeApi("https://api.oxy.so", fetchImpl as unknown as typeof fetch)
    const error = await api.registerDevice().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BridgeApiError)
    expect((error as BridgeApiError).code).toBe("invalid_device_secret")
    expect((error as BridgeApiError).status).toBe(401)
  })
})
