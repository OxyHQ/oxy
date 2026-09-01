import { useState, useRef, useEffect } from "react"
import { useNavigate, Link } from "react-router-dom"
import { toast } from "@oxyhq/bloom"
import { ArrowLeft, KeyRound, QrCode, Usb } from "lucide-react"
import { isOxyRpOrigin, type SwitchableAccount } from "@oxyhq/core"
import { useOxy, useSwitchableAccounts } from "@oxyhq/services"
import { buildPostLoginRedirect } from "@/lib/auth-utils"
import { describePasskeyError } from "@/lib/passkey-error"
import { setBasePreset } from "@/lib/bloom-css"
import { useLayoutContext } from "@/lib/layout-context"
import { getOrCreateDeviceFingerprint } from "@/lib/device-fingerprint"
import { Button } from "@oxyhq/bloom/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { AccountChooser } from "@/components/account-chooser"
import { AuthFormLayout, AuthFormHeader, LoadingSpinner } from "@/components/auth-form-layout"

type LoginFormProps = React.ComponentProps<"div"> & {
    error?: string
    notice?: string
    sessionToken?: string
    redirectUri?: string
    state?: string
    clientId?: string
    codeChallenge?: string
    codeChallengeMethod?: string
    scope?: string
    /**
     * `response_mode=web_message` (popup sign-in), carried through to
     * `/authorize` so the result is posted to the opener rather than navigating
     * this popup to the relying party.
     */
    responseMode?: string
    /**
     * Username to pre-fill and re-authenticate. Set via `?login_hint=` when a
     * caller (e.g. the OAuth consent page's re-auth fallback) routes a specific
     * account here for explicit sign-in — pre-fills the handle so the user can
     * complete a username-first passkey assertion.
     */
    loginHint?: string
}

type LoginStep = "identifier" | "security-key"

/** Read an HTTP status off a thrown SDK error (ApiError-shaped or axios-shaped). */
function errorStatus(err: unknown): number | undefined {
    return (
        (err as { status?: number } | undefined)?.status ??
        (err as { response?: { status?: number } } | undefined)?.response?.status
    )
}

export function LoginForm({
    className,
    error,
    notice,
    sessionToken,
    redirectUri,
    state,
    clientId,
    codeChallenge,
    codeChallengeMethod,
    scope,
    responseMode,
    loginHint,
    ...props
}: LoginFormProps) {
    const navigate = useNavigate()
    const signupPath = (() => {
        const params = new URLSearchParams()
        if (sessionToken) params.set("token", sessionToken)
        if (redirectUri) params.set("redirect_uri", redirectUri)
        if (state) params.set("state", state)
        if (clientId) params.set("client_id", clientId)
        if (codeChallenge) params.set("code_challenge", codeChallenge)
        if (codeChallengeMethod) params.set("code_challenge_method", codeChallengeMethod)
        if (scope) params.set("scope", scope)
        if (responseMode) params.set("response_mode", responseMode)
        const qs = params.toString()
        return qs ? `/signup?${qs}` : "/signup"
    })()
    // The IdP authenticates through the SAME device-first SDK path every Oxy app
    // uses. Sign-in is a passkey (WebAuthn) assertion or the Commons QR /
    // shared-keychain handoff — password, social login, and 2FA were removed
    // ecosystem-wide. The SDK verifies the assertion, persists the zero-cookie
    // `{deviceId, deviceSecret}` credential, plants the access token, and
    // registers the account into the device set. "Sign in with Oxy" opens the
    // shared services OxyAccountDialog (QR / Commons device-flow handoff)
    // mounted by the OxyProvider at the app root.
    const {
        signInWithPasskey,
        switchToAccount,
        openAccountDialog,
    } = useOxy()
    const { setLogoSlot } = useLayoutContext()

    // Passkey (WebAuthn) sign-in is only meaningful on a first-party Oxy web
    // origin — a credential minted with `WEBAUTHN_RP_ID=oxy.so` can only be
    // asserted from `oxy.so`, a subdomain, or a loopback dev host. On any other
    // origin (or native/SSR) the browser would reject the ceremony, so we hide
    // the affordance entirely. `isOxyRpOrigin()` reads `location` once and is
    // stable for the page's lifetime, so it needs no reactive state.
    const passkeyAvailable = isOxyRpOrigin()
    const [passkeyPending, setPasskeyPending] = useState(false)

    const [localError, setLocalError] = useState<string | undefined>()
    const [rateLimitSeconds, setRateLimitSeconds] = useState(0)
    const displayError = rateLimitSeconds > 0 ? `Too many attempts. Try again in ${rateLimitSeconds}s.` : (localError ?? error)

    const [isSubmitting, setIsSubmitting] = useState(false)
    const [pendingAccountId, setPendingAccountId] = useState<string | null>(null)
    // When a login_hint is supplied (the chooser routed a non-active account
    // here for re-auth), bypass the chooser and go straight to the sign-in form.
    const [showLoginForm, setShowLoginForm] = useState(Boolean(loginHint))

    // Every account signed in on this device (1..N) — the same device-first SDK
    // projection every Oxy app renders. The chooser is shown as an additive front
    // screen whenever at least one account is present and the user hasn't opted
    // into "Use a different account".
    const { isLoading, currentSessionId, accounts } = useSwitchableAccounts()

    const [stepState, setStepState] = useState<{ step: LoginStep; direction: "forward" | "back" }>({
        step: "identifier",
        direction: "forward",
    })
    const { step, direction } = stepState

    const [identifier, setIdentifier] = useState(loginHint ?? "")

    const identifierRef = useRef<HTMLInputElement>(null)

    // Reset color on mount
    const mountedRef = useRef(false)
    if (!mountedRef.current) {
        mountedRef.current = true
        setBasePreset("oxy")
    }

    // Login-specific logo overrides must not leak into sibling auth routes
    // that share AuthLayout (signup, authorize).
    useEffect(() => {
        return () => setLogoSlot(null)
    }, [setLogoSlot])

    // One-time toasts from URL params
    const noticeShownRef = useRef(false)
    if (notice && !noticeShownRef.current) {
        noticeShownRef.current = true
        queueMicrotask(() => toast("Notice", { description: notice }))
    }
    const errorShownRef = useRef(false)
    if (error && !errorShownRef.current) {
        errorShownRef.current = true
        queueMicrotask(() => toast.error("Sign in failed", { description: error }))
    }

    // Rate limit countdown
    const rateLimitTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
    function startRateLimitCountdown(seconds: number) {
        setRateLimitSeconds(seconds)
        if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current)
        rateLimitTimerRef.current = setInterval(() => {
            setRateLimitSeconds((prev) => {
                if (prev <= 1) {
                    if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current)
                    return 0
                }
                return prev - 1
            })
        }, 1000)
    }

    function goToStep(next: LoginStep, dir: "forward" | "back" = "forward") {
        setLocalError(undefined)
        if (next === "identifier") {
            setBasePreset("oxy")
            setLogoSlot(null)
        }
        setStepState({ step: next, direction: dir })
        requestAnimationFrame(() => {
            if (next === "identifier" || next === "security-key") identifierRef.current?.focus()
        })
    }

    function redirectAfterLogin() {
        // The device-first session is already committed by the SDK funnel (token
        // planted, `{deviceId, deviceSecret}` persisted, account registered as
        // the active device account), so there is nothing to plant here — proceed
        // straight to `/authorize`, which targets the SDK's active account.
        navigate(buildPostLoginRedirect({
            sessionToken,
            redirectUri,
            state,
            clientId,
            codeChallenge,
            codeChallengeMethod,
            scope,
            responseMode,
        }))
    }

    /**
     * Username-first passkey sign-in. The typed handle scopes the server's
     * WebAuthn `allowCredentials` to that user's registered keys, so both a
     * platform passkey (Touch ID) and a non-discoverable hardware key (a
     * U2F/security key like a Google Titan, which stores no resident credential)
     * can be selected. The SDK drives the assertion ceremony, verifies it, and
     * commits the device-first session (token planted, `{deviceId, deviceSecret}`
     * persisted, account activated), so on success we reuse `redirectAfterLogin`.
     * A dismissed/aborted browser prompt is a normal user action, not a crash:
     * surface a calm inline message and let them retry.
     */
    async function attemptUsernamePasskey(username: string, failToast: string) {
        if (!username || passkeyPending || rateLimitSeconds > 0) return
        setLocalError(undefined)
        setPasskeyPending(true)
        try {
            const deviceFingerprint = await getOrCreateDeviceFingerprint()
            await signInWithPasskey({ username, deviceFingerprint: deviceFingerprint ?? undefined })
            redirectAfterLogin()
        } catch (err) {
            if (errorStatus(err) === 429) {
                startRateLimitCountdown(60)
                setLocalError("Too many attempts. Please wait a minute and try again.")
            } else {
                const message = describePasskeyError(err)
                setLocalError(message)
                toast.error(failToast, { description: message })
            }
            setPasskeyPending(false)
        }
    }

    async function handleIdentifierSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault()
        await attemptUsernamePasskey(identifier.trim(), "Sign in failed")
    }

    async function handleSecurityKeySignIn(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault()
        await attemptUsernamePasskey(identifier.trim(), "Security key sign-in failed")
    }

    /**
     * Discoverable (usernameless) passkey sign-in. The SDK drives the WebAuthn
     * assertion ceremony, verifies it, and commits the device-first session
     * (token planted, `{deviceId, deviceSecret}` persisted, account activated) —
     * so on success we reuse `redirectAfterLogin`. A dismissed/aborted browser
     * prompt is a normal user action, not a crash: surface a calm inline message
     * and let them retry.
     */
    async function handlePasskeySignIn() {
        if (passkeyPending || rateLimitSeconds > 0) return
        setLocalError(undefined)
        setPasskeyPending(true)
        try {
            const deviceFingerprint = await getOrCreateDeviceFingerprint()
            await signInWithPasskey({ deviceFingerprint: deviceFingerprint ?? undefined })
            redirectAfterLogin()
        } catch (err) {
            if (errorStatus(err) === 429) {
                startRateLimitCountdown(60)
                setLocalError("Too many attempts. Please wait a minute and try again.")
            } else {
                const message = describePasskeyError(err)
                setLocalError(message)
                toast.error("Passkey sign-in failed", { description: message })
            }
            setPasskeyPending(false)
        }
    }

    /**
     * Reveal the sign-in form pre-filled for `entry`'s account so the user can
     * re-authenticate explicitly (a username-first passkey assertion). Used when
     * a chosen account cannot be switched into silently. Clears any in-flight
     * pending state so the chooser row never spins while we transition.
     */
    function routeToReauth(entry: SwitchableAccount): void {
        setPendingAccountId(null)
        setIsSubmitting(false)
        const hint = entry.user.username ?? undefined
        if (hint) setIdentifier(hint)
        setShowLoginForm(true)
    }

    /**
     * A chooser row was selected. Google-style: EVERY signed-in account continues
     * without a fresh assertion. The active account proceeds straight to
     * `/authorize`; any sibling is switched into first (the uniform device-first
     * switch), then `/authorize` targets it. A switch failure falls back to
     * explicit re-auth.
     */
    async function handleSelectAccount(entry: SwitchableAccount): Promise<void> {
        setPendingAccountId(entry.accountId)
        setIsSubmitting(true)
        try {
            if (!entry.isCurrent) {
                await switchToAccount(entry.accountId)
            }
            redirectAfterLogin()
        } catch {
            routeToReauth(entry)
        }
    }

    function handleUseDifferentAccount(): void {
        setIdentifier("")
        setShowLoginForm(true)
    }

    // Resolve app context for OAuth flows
    const appContext = sessionToken ? "Sign in to continue" : "Use your Oxy account"

    if (isLoading) return <LoadingSpinner className={className} />

    // The chooser is the INITIAL front screen (returning device). Gate it on the
    // identifier step so the reactive `useSwitchableAccounts` update that fires
    // once a sign-in commits (the just-created account appears on the device)
    // cannot re-mask a later step.
    if (step === "identifier" && accounts.length > 0 && currentSessionId && !showLoginForm) {
        return (
            <AccountChooser
                className={className}
                accounts={accounts}
                onSelectAccount={handleSelectAccount}
                onUseAnother={handleUseDifferentAccount}
                pendingAccountId={pendingAccountId}
                isLoading={isSubmitting}
                {...props}
            />
        )
    }

    const animationClass = direction === "forward" ? "auth-step-forward" : "auth-step-back"

    return (
        <AuthFormLayout
            className={className}
            footer={step === "identifier" ? (
                <div className="flex flex-col gap-4">
                    {/* Passkey option: a single tap runs the browser's WebAuthn
                        prompt (discoverable credential — no username needed) and
                        the SDK commits the session on success. First-party Oxy web
                        origins only. */}
                    {passkeyAvailable && (
                        <Button
                            type="button"
                            variant="outline"
                            size="lg"
                            className="w-full"
                            loading={passkeyPending}
                            disabled={passkeyPending || rateLimitSeconds > 0}
                            onClick={() => { void handlePasskeySignIn() }}
                        >
                            <KeyRound className="size-4" />
                            Sign in with a passkey
                        </Button>
                    )}
                    {/* Security-key option: a non-discoverable hardware key (U2F,
                        e.g. a Google Titan) can't be located by the usernameless
                        prompt above, so this reveals a handle step that scopes the
                        WebAuthn allow-list to that user's registered keys. */}
                    {passkeyAvailable && (
                        <Button
                            type="button"
                            variant="outline"
                            size="lg"
                            className="w-full"
                            disabled={passkeyPending || rateLimitSeconds > 0}
                            onClick={() => goToStep("security-key", "forward")}
                        >
                            <Usb className="size-4" />
                            Sign in with a security key
                        </Button>
                    )}
                    {/* Cross-device "Sign in with Oxy" (QR). The user approves in
                        their Oxy app on their phone — no password here. */}
                    <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        className="w-full"
                        onClick={() => openAccountDialog("signin")}
                    >
                        <QrCode className="size-4" />
                        Sign in with Oxy
                    </Button>
                </div>
            ) : undefined}
            {...props}
        >
            {/* Step 1: Username → username-first passkey */}
            {step === "identifier" && (
                <form onSubmit={handleIdentifierSubmit} key="identifier" className={animationClass}>
                    <FieldGroup>
                        <AuthFormHeader title="Sign in" description={appContext} />
                        <Field data-invalid={displayError ? true : undefined}>
                            <FieldLabel htmlFor="identifier">Username</FieldLabel>
                            <Input
                                ref={identifierRef}
                                id="identifier"
                                name="identifier"
                                type="text"
                                placeholder="yourname"
                                autoComplete="username webauthn"
                                value={identifier}
                                onChange={(e) => {
                                    setIdentifier(e.target.value)
                                    if (localError) setLocalError(undefined)
                                }}
                                required
                                autoFocus
                                disabled={passkeyPending || rateLimitSeconds > 0}
                            />
                            {displayError && <FieldError>{displayError}</FieldError>}
                        </Field>
                        <FieldDescription>
                            Don&apos;t have an account?{" "}
                            <Link to={signupPath}>Create account</Link>
                        </FieldDescription>
                        <Field>
                            <Button type="submit" size="lg" className="w-full" loading={passkeyPending} disabled={passkeyPending || rateLimitSeconds > 0}>
                                Continue
                            </Button>
                        </Field>
                    </FieldGroup>
                </form>
            )}

            {/* Security-key step: username-first passkey for a NON-discoverable
                hardware key (U2F, e.g. a Google Titan). The handle scopes the
                server's `allowCredentials` to that user's registered keys so a
                key with no resident credential can still assert. Reuses the
                identifier field + state. */}
            {step === "security-key" && (
                <form onSubmit={handleSecurityKeySignIn} key="security-key" className={animationClass}>
                    <FieldGroup>
                        <AuthFormHeader title="Sign in with a security key" description="Enter your username, then tap your security key." />
                        <Field data-invalid={displayError ? true : undefined}>
                            <FieldLabel htmlFor="security-key-identifier">Username</FieldLabel>
                            <Input
                                ref={identifierRef}
                                id="security-key-identifier"
                                name="identifier"
                                type="text"
                                placeholder="yourname"
                                autoComplete="username"
                                value={identifier}
                                onChange={(e) => {
                                    setIdentifier(e.target.value)
                                    if (localError) setLocalError(undefined)
                                }}
                                required
                                autoFocus
                                disabled={passkeyPending || rateLimitSeconds > 0}
                            />
                            {displayError && <FieldError>{displayError}</FieldError>}
                        </Field>
                        <div className="flex gap-3">
                            <Button type="button" variant="outline" size="lg" onClick={() => goToStep("identifier", "back")} className="shrink-0" aria-label="Go back" disabled={passkeyPending}>
                                <ArrowLeft className="size-4" />
                            </Button>
                            <Button type="submit" size="lg" className="flex-1 min-w-0" loading={passkeyPending} disabled={passkeyPending || rateLimitSeconds > 0}>
                                <Usb className="size-4" />
                                Continue
                            </Button>
                        </div>
                    </FieldGroup>
                </form>
            )}

        </AuthFormLayout>
    )
}
