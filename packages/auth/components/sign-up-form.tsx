import { useState, useRef, useCallback, useEffect } from "react"
import { useNavigate, Link } from "react-router-dom"
import { toast } from "@oxyhq/bloom/toast"
import { Check, KeyRound, X, Loader2 } from "lucide-react"
import { useOxy } from "@oxyhq/services"

import { buildApiUrl } from "@/lib/oxy-api-client"
import { buildPostLoginRedirect } from "@/lib/auth-utils"
import { describePasskeyError } from "@/lib/passkey-error"
import { Button } from "@oxyhq/bloom/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
}

type AvailabilityStatus = "idle" | "checking" | "available" | "taken"

function useAvailabilityCheck(endpoint: string) {
    const [status, setStatus] = useState<AvailabilityStatus>("idle")
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const controllerRef = useRef<AbortController | null>(null)

    const check = useCallback((value: string) => {
        if (timerRef.current) clearTimeout(timerRef.current)
        if (controllerRef.current) controllerRef.current.abort()

        if (!value || value.length < 3) {
            setStatus("idle")
            return
        }

        setStatus("checking")
        timerRef.current = setTimeout(async () => {
            controllerRef.current = new AbortController()
            try {
                const res = await fetch(
                    buildApiUrl(`${endpoint}/${encodeURIComponent(value)}`),
                    { signal: controllerRef.current.signal }
                )
                const data = await res.json().catch(() => ({}))
                setStatus(data?.data?.available ? "available" : "taken")
            } catch {
                // Aborted or network error — don't update status
            }
        }, 400)
    }, [endpoint])

    const reset = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current)
        if (controllerRef.current) controllerRef.current.abort()
        setStatus("idle")
    }, [])

    // Tear down on unmount: a debounce that survives the form fires its request
    // several hundred milliseconds after the screen is gone, against whatever
    // the page has become by then.
    useEffect(
        () => () => {
            if (timerRef.current) clearTimeout(timerRef.current)
            if (controllerRef.current) controllerRef.current.abort()
        },
        [],
    )

    return { status, check, reset }
}

function AvailabilityIndicator({ status, takenMessage }: { status: AvailabilityStatus; takenMessage: string }) {
    if (status === "idle") return null
    if (status === "checking") return <span className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="size-3 animate-spin" /> Checking...</span>
    if (status === "available") return <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1"><Check className="size-3" /> Available</span>
    return <span className="text-xs text-destructive flex items-center gap-1"><X className="size-3" /> {takenMessage}</span>
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
        const query = params.toString()
        return query ? `/login?${query}` : "/login"
    })()
    // Sign-up commits its session through the SAME device-first SDK funnel every
    // Oxy app uses (`registerWithPasskey`): it runs the WebAuthn creation
    // ceremony, plants the access token, persists the zero-cookie
    // `{deviceId, deviceSecret}` credential, and registers the new account into
    // the device set as the active account — so `/authorize` targets it. Password
    // and social sign-up were removed ecosystem-wide; a passkey is the sole
    // first-party sign-up method (only a username is collected — the backend
    // register/verify path reads `envelope.username` and nothing else).
    const { registerWithPasskey } = useOxy()
    const [localError, setLocalError] = useState<string | undefined>()
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [passkeyUsername, setPasskeyUsername] = useState("")

    const displayError = localError ?? error

    const passkeyUsernameCheck = useAvailabilityCheck("/auth/check-username")

    const errorShownRef = useRef(false)
    if (error && !errorShownRef.current) {
        errorShownRef.current = true
        queueMicrotask(() => toast.error("Sign up failed", { description: error }))
    }

    /**
     * Passkey signup: register a brand-new account whose FIRST auth method is a
     * passkey. Only a username is collected — the SDK runs the WebAuthn creation
     * ceremony, verifies it, and commits the device-first session, so on success
     * we redirect to the OAuth authorize step. A dismissed/aborted browser prompt
     * is a normal user action: surface a calm inline message and let them retry.
     */
    async function handlePasskeySubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault()
        const usernameValue = passkeyUsername.trim()
        if (!usernameValue || passkeyUsernameCheck.status === "taken" || isSubmitting) return
        setLocalError(undefined)
        setIsSubmitting(true)
        let didRedirect = false
        try {
            await registerWithPasskey({ username: usernameValue })
            didRedirect = true
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
            }))
        } catch (err) {
            const message = describePasskeyError(err)
            setLocalError(message)
            toast.error("Passkey signup failed", { description: message })
        } finally {
            if (!didRedirect) setIsSubmitting(false)
        }
    }

    return (
        <AuthFormLayout className={className} {...props}>
            <form onSubmit={handlePasskeySubmit}>
                <FieldGroup>
                    <AuthFormHeader
                        title="Create your account"
                        description="Pick a username — no password needed. Your device will create a passkey."
                    />
                    <Field data-invalid={displayError ? true : undefined}>
                        <FieldLabel htmlFor="passkey-username">Username</FieldLabel>
                        <Input
                            id="passkey-username"
                            name="passkey-username"
                            type="text"
                            placeholder="yourname"
                            autoComplete="username webauthn"
                            required
                            autoFocus
                            value={passkeyUsername}
                            onChange={(e) => {
                                const value = e.target.value
                                setPasskeyUsername(value)
                                if (localError) setLocalError(undefined)
                                passkeyUsernameCheck.check(value.trim())
                            }}
                        />
                        <AvailabilityIndicator status={passkeyUsernameCheck.status} takenMessage="This username is taken" />
                        {displayError && <FieldError>{displayError}</FieldError>}
                    </Field>
                    <Field>
                        <Button
                            type="submit"
                            size="lg"
                            className="w-full"
                            loading={isSubmitting}
                            disabled={isSubmitting || passkeyUsernameCheck.status === "taken"}
                        >
                            <KeyRound className="size-4" />
                            Create passkey
                        </Button>
                    </Field>
                    <FieldDescription>
                        Already have an account? <Link to={loginPath}>Sign in</Link>
                    </FieldDescription>
                </FieldGroup>
            </form>
        </AuthFormLayout>
    )
}
