type PostLoginRedirectParams = {
    sessionToken?: string
    redirectUri?: string
    state?: string
    clientId?: string
    codeChallenge?: string
    codeChallengeMethod?: string
    scope?: string
    resource?: string
    responseType?: string
    /**
     * `response_mode=web_message` (popup sign-in). Carried across the sign-in
     * hop so a popup that had to authenticate still delivers its result to the
     * opener instead of navigating itself to the relying party.
     */
    responseMode?: string
    /**
     * `?mcp_link_intent=` — an in-flight invitation to add THIS account to an
     * existing MCP connection. It has no relying party and no redirect: the hop
     * lands back on `/mcp/link`, where the person approves for whichever account
     * they just signed in as.
     */
    mcpLinkIntent?: string
}

/**
 * Build the URL path for redirecting after a successful login/signup.
 * Navigates to /authorize with the appropriate query params, or sets an
 * error if no authorization request context was provided.
 *
 * No `authuser` hint: the caller has already committed the device-first session
 * through the shared SDK funnel (`signInWithPasskey` / `registerWithPasskey` /
 * `handleWebSession`), so the just-authenticated account is the SDK's ACTIVE
 * account. `/authorize`
 * targets that active account and offers the device chooser
 * (`useDeviceSwitcher`) to activate a context — the same mechanism every Oxy
 * app uses.
 */
export function buildPostLoginRedirect({
    sessionToken,
    redirectUri,
    state,
    clientId,
    codeChallenge,
    codeChallengeMethod,
    scope,
    resource,
    responseType,
    responseMode,
    mcpLinkIntent,
}: PostLoginRedirectParams): string {
    if (mcpLinkIntent) {
        const linkUrl = new URL("/mcp/link", window.location.origin)
        linkUrl.searchParams.set("intent", mcpLinkIntent)
        return `${linkUrl.pathname}${linkUrl.search}`
    }
    const nextUrl = new URL("/authorize", window.location.origin)
    if (sessionToken) nextUrl.searchParams.set("token", sessionToken)
    if (redirectUri) nextUrl.searchParams.set("redirect_uri", redirectUri)
    if (state) nextUrl.searchParams.set("state", state)
    if (clientId) nextUrl.searchParams.set("client_id", clientId)
    if (codeChallenge) nextUrl.searchParams.set("code_challenge", codeChallenge)
    if (codeChallengeMethod) nextUrl.searchParams.set("code_challenge_method", codeChallengeMethod)
    if (scope) nextUrl.searchParams.set("scope", scope)
    if (resource) nextUrl.searchParams.set("resource", resource)
    if (responseType) nextUrl.searchParams.set("response_type", responseType)
    if (responseMode) nextUrl.searchParams.set("response_mode", responseMode)
    if (!sessionToken && !redirectUri && !clientId) {
        nextUrl.searchParams.set(
            "error",
            "No authorization request found. Return to the app and try again."
        )
    }
    return `${nextUrl.pathname}${nextUrl.search}`
}
