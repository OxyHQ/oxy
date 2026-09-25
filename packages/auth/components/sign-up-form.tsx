import { useEffect, useRef } from "react"
import { useNavigate, Link } from "react-router-dom"
import { toast } from "@oxy.so/bloom/toast"
import { KeyRound } from "lucide-react"
import { useOxy } from "@oxy.so/services"

import { buildPostLoginRedirect } from "@/lib/auth-utils"
import { Button } from "@oxy.so/bloom/button"
import { FieldDescription, FieldGroup, Field } from "@/components/ui/field"
import { AuthFormLayout, AuthFormHeader } from "@/components/auth-form-layout"

type SignUpFormProps = React.ComponentProps<"div"> & {
    error?: string
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
     * `response_mode=web_message` (popup sign-in), carried through to
     * `/authorize` so the result is posted to the opener rather than navigating
     * this popup to the relying party.
     */
    responseMode?: string
    /** `?mcp_link_intent=` — return to `/mcp/link` after the account exists. */
    mcpLinkIntent?: string
    /** `?user_code=` — return to `/device` after the account exists. */
    userCode?: string
}

export function SignUpForm({
    className,
    error,
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
    ...props
}: SignUpFormProps) {
    const navigate = useNavigate()
    const loginPath = (() => {
        const params = new URLSearchParams()
        if (sessionToken) params.set("token", sessionToken)
        if (redirectUri) params.set("redirect_uri", redirectUri)
        if (state) params.set("state", state)
        if (clientId) params.set("client_id", clientId)
        if (codeChallenge) params.set("code_challenge", codeChallenge)
        if (codeChallengeMethod) params.set("code_challenge_method", codeChallengeMethod)
        if (scope) params.set("scope", scope)
        if (resource) params.set("resource", resource)
        if (responseType) params.set("response_type", responseType)
        if (responseMode) params.set("response_mode", responseMode)
        if (mcpLinkIntent) params.set("mcp_link_intent", mcpLinkIntent)
        if (userCode) params.set("user_code", userCode)
        const query = params.toString()
        return query ? `/login?${query}` : "/login"
    })()

    // An Oxy account is created WITH its self-custody root, or not at all
    // (ADR 0024 D4). That happens in the canonical account flow — the same one
    // every Oxy app's account dialog opens — never on this page: this origin runs
    // product analytics and the full SDK graph, and must not generate or seal a
    // root. The flow signs THIS origin in when it completes; the effect below
    // then continues to `/authorize` exactly as a sign-in does.
    const { accountDialogController, openAccountDialog, isAuthenticated } = useOxy()

    const errorShownRef = useRef(false)
    if (error && !errorShownRef.current) {
        errorShownRef.current = true
        queueMicrotask(() => toast.error("Sign up failed", { description: error }))
    }

    // Continue only on a sign-in that happened WHILE this page was open: an
    // already-signed-in visitor chose "create an account" and must not be
    // silently sent on as the existing account.
    const wasAuthenticatedRef = useRef(isAuthenticated)
    useEffect(() => {
        if (isAuthenticated && !wasAuthenticatedRef.current) {
            navigate(buildPostLoginRedirect({
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
            }))
        }
        wasAuthenticatedRef.current = isAuthenticated
    }, [isAuthenticated, navigate, sessionToken, redirectUri, state, clientId, codeChallenge, codeChallengeMethod, scope, resource, responseType, responseMode, mcpLinkIntent, userCode])

    function handleCreate() {
        // Both synchronous, inside the click: the account window is a popup, and
        // a browser only lets a user gesture open one. The dialog underneath
        // shows the same request's Commons code as the alternative.
        openAccountDialog("signin")
        void accountDialogController?.startPasskeyHubSignIn()
    }

    return (
        <AuthFormLayout className={className} {...props}>
            <FieldGroup>
                <AuthFormHeader
                    title="Create your account"
                    description="No password. Your device creates a passkey, and your account gets a recovery phrase only you keep."
                />
                <Field>
                    <Button type="button" size="lg" className="w-full" onClick={handleCreate}>
                        <KeyRound className="size-4" />
                        Create account
                    </Button>
                </Field>
                <FieldDescription>
                    Already have an account? <Link to={loginPath}>Sign in</Link>
                </FieldDescription>
            </FieldGroup>
        </AuthFormLayout>
    )
}
