/**
 * The `__Host-oxy-device` cookie, held to its EXACT attribute set.
 *
 * This is the security surface of ADR 0003 that a suite can actually hold, so
 * the assertions are deliberately literal: the whole `Set-Cookie` line, not a
 * `toContain` per attribute. A `toContain('HttpOnly')` would still pass if the
 * line also grew `Domain=.oxy.so`, which is the one attribute the design exists
 * to forbid.
 *
 * Mutation-tested: deleting `HttpOnly`, `Secure`, `SameSite=Lax` or `Path=/`
 * from `BROWSER_HUB_COOKIE_ATTRIBUTES`, or adding a `Domain`, turns the exact
 * assertions red.
 */

import { describe, expect, test } from "bun:test"
import { BROWSER_HUB_HANDLE_TTL_MS } from "@oxyhq/contracts"
import { clearedHubCookieHeader, hubCookieHeader, readHubHandle } from "../cookie"

const HANDLE = "Zm9vYmFyLWhhbmRsZS12YWx1ZS0zMi1ieXRlcy1sb25n_x"

function requestWithCookie(cookie: string | null): Request {
    return new Request("https://auth.oxy.so/hub/session", {
        method: "POST",
        headers: cookie === null ? {} : { cookie },
    })
}

describe("hubCookieHeader", () => {
    test("is exactly the ADR 0003 attribute set plus a lifetime", () => {
        const maxAge = Math.floor(BROWSER_HUB_HANDLE_TTL_MS / 1000)
        expect(hubCookieHeader(HANDLE)).toBe(
            `__Host-oxy-device=${HANDLE}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`
        )
    })

    test("carries no Domain attribute", () => {
        // The `__Host-` prefix makes a browser REFUSE a cookie carrying one, so
        // this is belt and braces — but it is the specific alternative ADR 0003
        // rejected (any oxy.so subdomain could then read or overwrite the
        // browser's device handle), so it gets its own named assertion.
        expect(hubCookieHeader(HANDLE).toLowerCase()).not.toContain("domain")
    })

    test("the value is the handle and nothing else", () => {
        const value = hubCookieHeader(HANDLE).split(";")[0]
        expect(value).toBe(`__Host-oxy-device=${HANDLE}`)
        // No device id, user id, account id, expiry, signature or any other
        // serialized state travels in the cookie: everything after the handle is
        // an attribute name, never data.
        expect(value.split("=")).toHaveLength(2)
    })

    test("the cookie lifetime matches the server-side credential lifetime", () => {
        // Read off the SAME constant the API writes into `hub_secret_expires_at`.
        // A cookie outliving its credential is a browser that believes it is
        // signed in and is refused on every call.
        const maxAge = Number(
            /Max-Age=(\d+)/.exec(hubCookieHeader(HANDLE))?.[1] ?? "0"
        )
        expect(maxAge).toBe(BROWSER_HUB_HANDLE_TTL_MS / 1000)
        expect(maxAge).toBeGreaterThan(0)
    })

    test("refuses a handle that is not cookie-safe", () => {
        // A value containing `;` is not a malformed cookie, it is a second
        // attribute — which is how a `Domain` or a `SameSite=None` would get in.
        expect(() => hubCookieHeader("abc; Domain=.oxy.so")).toThrow()
        expect(() => hubCookieHeader("abc\r\nSet-Cookie: other=1")).toThrow()
        expect(() => hubCookieHeader("")).toThrow()
    })
})

describe("clearedHubCookieHeader", () => {
    test("repeats the write's attribute set with a zero lifetime", () => {
        // A `__Host-` cookie cleared without `Secure` and `Path=/` is rejected
        // outright, leaving the live cookie in place while the response looks
        // like it worked.
        expect(clearedHubCookieHeader()).toBe(
            "__Host-oxy-device=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
        )
    })
})

describe("readHubHandle", () => {
    test("finds the handle among other cookies", () => {
        expect(
            readHubHandle(
                requestWithCookie(`theme=dark; __Host-oxy-device=${HANDLE}; lang=es`)
            )
        ).toBe(HANDLE)
    })

    test("tolerates the whitespace browsers actually send", () => {
        expect(
            readHubHandle(requestWithCookie(`a=1;__Host-oxy-device=${HANDLE}`))
        ).toBe(HANDLE)
    })

    test("returns null when the cookie is absent", () => {
        expect(readHubHandle(requestWithCookie("theme=dark"))).toBeNull()
        expect(readHubHandle(requestWithCookie(null))).toBeNull()
    })

    test("returns null for an empty value rather than an empty string", () => {
        // A cleared cookie a browser has not dropped yet. Returning `''` would
        // send an empty handle upstream and read the 401 as a dead session
        // rather than as "no session here".
        expect(readHubHandle(requestWithCookie("__Host-oxy-device=; a=1"))).toBeNull()
    })

    test("does not match a look-alike cookie name", () => {
        // `oxy-device` without the prefix is a cookie ANY oxy.so host can set.
        expect(
            readHubHandle(requestWithCookie(`oxy-device=${HANDLE}`))
        ).toBeNull()
        expect(
            readHubHandle(requestWithCookie(`x__Host-oxy-device=${HANDLE}`))
        ).toBeNull()
    })
})
