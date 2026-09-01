import { useCallback, useEffect, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { OxyAuthChooser, useOxy } from "@oxyhq/services"
import { getCommonsApprovalBlockingReason, getNormalizedUserHandle, type CommonsApprovalInfo } from "@oxyhq/core"
import { Button } from "@oxyhq/bloom/button"
import { buildAuthUrl } from "@/lib/oxy-api-client"
import { AuthFormLayout, AuthFormHeader, LoadingSpinner } from "@/components/auth-form-layout"

/**
 * Cross-origin passkey hub (b2).
 *
 * A non-Oxy-origin app (mention.earth, homiio.com, …) can't run a WebAuthn
 * ceremony locally — a credential minted with `WEBAUTHN_RP_ID=oxy.so` can
 * only be asserted from `oxy.so`/a subdomain/loopback. Its `OxyAccountDialog`
 * instead opens THIS page as a popup (`AccountDialogController.
 * startPasskeyHubSignIn`), where the ceremony IS first-party, and relays the
 * result back.
 *
 * This page mounts the SAME `OxyAuthChooser` every other Oxy surface uses —
 * bare, no Dialog chrome — so every sign-in/sign-up path (passkey, Commons
 * QR, switching an existing hub-local account) works here for free.
 *
 * SECURITY (post-review, see PR #640): completing `OxyAuthChooser` only
 * plants a bearer on THIS origin — it does NOT, by itself, authorize the
 * opener's pending session. `OxyAuthChooser`'s "tap your already-active
 * account row" shortcut is a silent, one-tap completion by design (it's
 * fine inside a normal in-app dialog), but here it would let an attacker who
 * crafted their OWN `authorizeCode` (from their own registered app, or their
 * own self-registered third-party app) get a signed-in victim to
 * unknowingly authorize THAT attacker-controlled session just by tapping
 * their own name — a one-click login-CSRF / session-fixation. So the actual
 * authorize call NEVER fires from `OxyAuthChooser`'s `onComplete` directly:
 * it only flags "ready to confirm," and a SEPARATE, mandatory "Authorize
 * sign-in to <App>?" screen (showing the resolved app identity + the
 * account that's about to be used) requires an explicit press before
 * `POST /auth/session/authorize-code/:code` (bearer-authed) ever fires.
 *
 * That screen ALWAYS requires an explicit, unchecked-by-default
 * acknowledgement before "Authorize" enables — regardless of
 * `approval.originVerified`. `originVerified` is derived server-side from
 * the `Origin` header on the unauthenticated `session/create` call, which
 * only a real BROWSER is forced to send honestly (CORS); a non-browser
 * caller can forge it to a TRUSTED app's own registered origin and have it
 * compute `true`. The hub is a same-browser popup with no way to verify the
 * opener actually corresponds to that origin, so it can never be a
 * checkbox-free lane — `originVerified` only changes the warning's wording
 * (stronger alarm when `false`), never whether the acknowledgement is
 * required. Modeled on the Commons approver's own non-suppressible
 * anti-phishing warning for the same underlying signal.
 */
export function HubPasskeyPage() {
    const [searchParams] = useSearchParams()
    const code = searchParams.get("code")
    const { oxyServices, accountDialogController, user } = useOxy()

    const [approval, setApproval] = useState<CommonsApprovalInfo | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [authorizeError, setAuthorizeError] = useState<string | null>(null)
    const [done, setDone] = useState(false)
    const completingRef = useRef(false)

    // Set once OxyAuthChooser completes (a bearer now exists on THIS origin)
    // — but the authorize-code POST does NOT fire yet. See the module doc.
    const [readyToConfirm, setReadyToConfirm] = useState(false)
    const [acknowledgedUnverified, setAcknowledgedUnverified] = useState(false)

    const hasOpener = typeof window !== "undefined" && window.opener != null

    // Jump straight to the sign-in entry — on web this auto-starts "Sign in
    // with Oxy" (the QR + passkey link, since this origin IS oxy.so). Any
    // account already active on THIS device still shows above it.
    useEffect(() => {
        accountDialogController?.setView("signin")
    }, [accountDialogController])

    useEffect(() => {
        if (!code) return
        let cancelled = false
        void oxyServices
            .getCommonsApprovalInfo(code)
            .then((info) => {
                if (cancelled) return
                const blockingReason = getCommonsApprovalBlockingReason(info)
                if (blockingReason) {
                    setLoadError(blockingReason)
                    return
                }
                setApproval(info)
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setLoadError(
                        error instanceof Error ? error.message : "This sign-in request could not be found.",
                    )
                }
            })
        return () => {
            cancelled = true
        }
    }, [code, oxyServices])

    // OxyAuthChooser completed (passkey ceremony, Commons QR, or tapping an
    // already-active account) — do NOT authorize yet, just surface the
    // mandatory confirmation screen below.
    const handleChooserComplete = useCallback(() => {
        setReadyToConfirm(true)
    }, [])

    // "Not you? Choose a different account" — back out of the confirmation
    // WITHOUT denying the opener's flow (it's still pending; they may just
    // want to pick a different account or method).
    const handleChooseDifferentAccount = useCallback(() => {
        setReadyToConfirm(false)
        setAcknowledgedUnverified(false)
        setAuthorizeError(null)
        accountDialogController?.cancelSignIn()
        accountDialogController?.setView("accounts")
    }, [accountDialogController])

    // The ONLY path that calls the authorize-code endpoint — an explicit
    // button press on the confirmation screen.
    const handleAuthorizePress = useCallback(() => {
        if (!code || completingRef.current) return
        completingRef.current = true
        void (async () => {
            try {
                const accessToken = oxyServices.getAccessToken()
                if (!accessToken) {
                    throw new Error("Sign-in did not produce an access token.")
                }
                const response = await fetch(
                    buildAuthUrl(`/session/authorize-code/${encodeURIComponent(code)}`),
                    {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                            Authorization: `Bearer ${accessToken}`,
                        },
                        body: "{}",
                    },
                )
                if (!response.ok) {
                    const payload = await response.json().catch(() => null)
                    const message =
                        typeof payload?.message === "string" ? payload.message : "Could not complete sign-in."
                    throw new Error(message)
                }
                setDone(true)
                window.setTimeout(() => window.close(), 800)
            } catch (error) {
                completingRef.current = false
                setAuthorizeError(error instanceof Error ? error.message : "Could not complete sign-in.")
            }
        })()
    }, [code, oxyServices])

    const handleCancel = useCallback(() => {
        if (code) {
            void oxyServices.denyCommonsSignIn(code).catch(() => undefined)
        }
        window.close()
    }, [code, oxyServices])

    if (!code || !hasOpener) {
        return (
            <AuthFormLayout>
                <AuthFormHeader
                    title="Can't open this here"
                    description="Open this page from the app that asked you to sign in."
                />
            </AuthFormLayout>
        )
    }

    if (loadError) {
        return (
            <AuthFormLayout>
                <AuthFormHeader title="Sign-in request expired" description={loadError} />
            </AuthFormLayout>
        )
    }

    if (!approval?.application) {
        return (
            <AuthFormLayout>
                <LoadingSpinner />
            </AuthFormLayout>
        )
    }

    const application = approval.application

    if (done) {
        return (
            <AuthFormLayout>
                <AuthFormHeader
                    title="You're signed in"
                    description="You can close this window — it'll close on its own in a moment."
                />
            </AuthFormLayout>
        )
    }

    if (readyToConfirm) {
        // The acknowledgement is MANDATORY in every case, never gated on
        // `approval.originVerified` alone: `originVerified` is derived from
        // the `Origin` header on the unauthenticated `session/create` call,
        // which only a real BROWSER is forced to send honestly (CORS) — a
        // non-browser caller can forge it to a trusted app's own registered
        // origin. The hub is a same-browser popup with no way to verify the
        // opener actually corresponds to that origin, so every hub
        // authorization is treated as unverified for consent purposes,
        // regardless of what the server-computed signal says. `originVerified`
        // still drives which warning copy renders (the unverified case gets
        // the stronger alarm), but never whether a checkbox is required.
        const canAuthorize = acknowledgedUnverified
        return (
            <AuthFormLayout>
                <AuthFormHeader
                    title={`Authorize sign-in to ${application.name}?`}
                    description={`Continuing as ${user?.name?.displayName ?? getNormalizedUserHandle(user) ?? ''}.`}
                />
                <label className="flex items-start gap-2 text-sm">
                    <input
                        type="checkbox"
                        className="mt-1"
                        checked={acknowledgedUnverified}
                        onChange={(event) => setAcknowledgedUnverified(event.target.checked)}
                    />
                    <span>
                        {approval.originVerified
                            ? `I started this sign-in myself in ${application.name}.`
                            : `We couldn't verify where this request came from. I understand the risk and started this sign-in myself in ${application.name}.`}
                    </span>
                </label>
                {authorizeError && <p className="text-destructive text-sm">{authorizeError}</p>}
                <Button disabled={!canAuthorize} onClick={handleAuthorizePress}>
                    Authorize
                </Button>
                <Button variant="ghost" onClick={handleChooseDifferentAccount}>
                    Not you? Choose a different account
                </Button>
                <Button variant="ghost" onClick={handleCancel}>
                    Cancel
                </Button>
            </AuthFormLayout>
        )
    }

    return (
        <AuthFormLayout>
            <AuthFormHeader title={`Continue to ${application.name}`} />
            <OxyAuthChooser autoStartSignIn={false} onComplete={handleChooserComplete} />
            <Button variant="ghost" onClick={handleCancel}>
                Cancel
            </Button>
        </AuthFormLayout>
    )
}
