/**
 * Entry of `auth.oxy.so/bridge` (see `lib/bridge.ts`). No React, no UI: it runs,
 * posts one message to the app that opened it, and closes.
 */
import { createWebAuthStateStore } from "@oxy.so/core"
import {
  BRIDGE_ERROR_MESSAGE_TYPE,
  createBridgeApi,
  deliverBridgeMessage,
  parseBridgeRequest,
  runBridge,
  type BridgeOpener,
} from "@/lib/bridge"
import { getApiBaseUrl } from "@/lib/oxy-api-client"

async function main(): Promise<void> {
  const opener = window.opener as BridgeOpener | null
  const request = parseBridgeRequest(window.location.search)
  if (request) {
    const api = createBridgeApi(getApiBaseUrl())
    const message = await runBridge({ store: createWebAuthStateStore(), ...api }, request)
    deliverBridgeMessage(opener, message, request.targetOrigin)
  } else {
    // Without a valid redirect URI there is no origin to answer to; the app's
    // window watch sees this one close.
    const redirectUri = new URLSearchParams(window.location.search).get("redirect_uri")
    const state = new URLSearchParams(window.location.search).get("state") ?? ""
    try {
      const origin = redirectUri ? new URL(redirectUri).origin : null
      if (origin) {
        deliverBridgeMessage(opener, { type: BRIDGE_ERROR_MESSAGE_TYPE, error: "invalid_request", state }, origin)
      }
    } catch {
      // Nothing to answer to.
    }
  }
}

void main().finally(() => {
  window.close()
})
