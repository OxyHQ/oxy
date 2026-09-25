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
    /**
     * `?user_code=` — the PUBLIC approval code of a device sign-in a CLI (or
     * any client without a browser of its own) started. Like the MCP link it has
     * no relying party and no redirect: the hop lands back on `/device?user_code=`, where
     * the person approves as whichever account they just signed in as, and the
     * waiting client finishes on its own by polling.
     */
    userCode?: string
}

/**
 * Build the URL path for redirecting after a successful login/signup.
 * Navigates to /authorize with the appropriate query params, or sets an
 * error if no authorization request context was provided.
 *
 * No `authuser` hint: the caller has already committed the device-first session
 * through the shared SDK funnel (`signInWithPasskey` /
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
    userCode,
}: PostLoginRedirectParams): string {
    if (mcpLinkIntent) return pathWithQuery("/mcp/link", { intent: mcpLinkIntent })
    if (userCode) return pathWithQuery("/device", { user_code: userCode })
    const hasRequest = Boolean(sessionToken || redirectUri || clientId)
    return pathWithQuery("/authorize", {
        token: sessionToken,
        redirect_uri: redirectUri,
        state,
        client_id: clientId,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        scope,
        resource,
        response_type: responseType,
        response_mode: responseMode,
        error: hasRequest ? undefined : "No authorization request found. Return to the app and try again.",
    })
}

/**
 * A same-origin path with its query — what a router navigates to. Built from
 * the parameters alone, so it needs no `window` (and runs in any test runner).
 */
function pathWithQuery(pathname: string, params: Record<string, string | undefined>): string {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
        if (value) query.set(key, value)
    }
    const search = query.toString()
    return search ? `${pathname}?${search}` : pathname
}
