/**
 * The authorize page's Commons lane (issue #691) — the IdP's HOST for the
 * shared "Sign in with Oxy" request surface.
 *
 * What this file owns is the lane's LIFECYCLE: exactly one
 * {@link CommonsOAuthRequest}, started on mount, abandoned on unmount, with its
 * single terminal outcome handed to the page's delivery funnel.
 *
 * What the in-flight request LOOKS like is not owned here at all. That is
 * `@oxyhq/services`' `OxySignInRequestSurface` — the same presentational
 * component the in-app account dialog renders — so the two hosts of a Commons
 * approval cannot drift apart. It resolves the shared `accountSwitcher.*` copy
 * (headline, progress ladder, "Having trouble?", "Try again") in all 11 locales
 * from the SDK's own dictionary, which is exactly the copy this lane used to
 * reach for through `t()`.
 *
 * What stays here is genuinely IdP page chrome, i.e. the parts a full-page
 * OAuth authorize screen owes the visitor and an in-app dialog does not:
 *
 *  - the auth card (`AuthFormLayout` + `AuthFormHeader`), titled with the
 *    SERVER-RESOLVED application name the page looked up via
 *    `GET /auth/oauth/client/:clientId`;
 *  - the failure BANNER. The surface reports only THAT the request failed and
 *    offers the way forward; wording the reason is the host's job, and on a full
 *    page that means an inline banner rather than the dialog's toast;
 *  - WHICH alternatives exist, and whether a fresh attempt can help at all
 *    (see {@link UNRECOVERABLE_FAILURES}).
 *
 * ANTI-PHISHING: the QR encodes `snapshot.qrPayload` and nothing is rendered
 * that derives from it — the requesting application's identity comes from the
 * server-resolved `appName`, never from the payload. And the payload itself
 * carries only the PUBLIC `authorizeCode`; the secret finalize credential is a
 * private field of the request and reaches neither this component nor any prop
 * of the surface.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { OxySignInRequestSurface } from "@oxyhq/services"
import type { OxySignInSurfaceAction } from "@oxyhq/services"
import { AuthFormLayout, AuthFormHeader } from "@/components/auth-form-layout"
import { useTranslation } from "@/lib/i18n/use-translation"
import { CommonsOAuthRequest } from "@/lib/commons-oauth-request"
import type {
    CommonsOAuthBinding,
    CommonsOAuthClient,
    CommonsOAuthFailure,
    CommonsOAuthOutcome,
} from "@/lib/commons-oauth-request"

/** Failure copy, one key per terminal reason the lane can report. */
const FAILURE_KEYS: Record<CommonsOAuthFailure, string> = {
    start_failed: "authorize.commons.errors.startFailed",
    request_expired: "authorize.commons.errors.requestExpired",
    unreachable: "authorize.commons.errors.unreachable",
    finalize_failed: "authorize.commons.errors.finalizeFailed",
    redirect_mismatch: "authorize.commons.errors.redirectMismatch",
}

/**
 * Failures a fresh request cannot fix. A mismatched redirect binding would come
 * back identical on every attempt, so offering "Try again" would only loop the
 * user through the same dead end — the lane withholds `onRetry` there, leaving
 * the alternatives as the only way forward.
 */
const UNRECOVERABLE_FAILURES: readonly CommonsOAuthFailure[] = ["redirect_mismatch"]

type CommonsOAuthLaneProps = {
    /** The OAuth binding built from the authorize URL's validated parameters. */
    binding: CommonsOAuthBinding
    /** The SDK client. `useOxy().oxyServices` satisfies this structurally. */
    client: CommonsOAuthClient
    /** Server-resolved application name, or null when the page has none to show. */
    appName?: string | null
    /**
     * The lane's ONE terminal outcome. The page delivers it through the SAME
     * `deliverOAuthResult` funnel the session-bearing path uses, so the popup
     * relay and the redirect fallback stay one decision.
     */
    onOutcome: (outcome: CommonsOAuthOutcome) => void
    /** Fall back to signing in on this origin (passkey / security key). */
    onSignInHere: () => void
}

/**
 * Owns the lane's lifecycle: exactly ONE {@link CommonsOAuthRequest} for the
 * component's lifetime, started on mount and abandoned on unmount.
 *
 * The controller is created once from the props it is given, so changing the
 * binding or the client means REMOUNTING this component — which is what the
 * authorize page does, since both are derived from URL parameters that cannot
 * change without a navigation.
 */
export function CommonsOAuthLane({
    binding,
    client,
    appName,
    onOutcome,
    onSignInHere,
}: CommonsOAuthLaneProps) {
    const { t } = useTranslation()

    // The outcome handler is invoked at most once, asynchronously, long after
    // construction — so the controller dispatches through a ref rather than
    // capturing whichever closure existed on the first render.
    const outcomeRef = useRef(onOutcome)
    useEffect(() => {
        outcomeRef.current = onOutcome
    }, [onOutcome])

    const [request] = useState(
        () =>
            new CommonsOAuthRequest({
                client,
                clientId: binding.clientId,
                oauth: binding.oauth,
                onOutcome: (outcome) => outcomeRef.current(outcome),
            }),
    )

    useEffect(() => {
        request.start()
        return () => request.dispose()
    }, [request])

    const snapshot = useSyncExternalStore(request.subscribe, request.getSnapshot, request.getSnapshot)

    const failed = snapshot.phase === "failed"
    const failure = snapshot.failure
    const qrPayload = snapshot.qrPayload

    const alternatives: OxySignInSurfaceAction[] = []
    if (qrPayload && !failed) {
        alternatives.push({
            key: "commons-open-on-this-device",
            label: t("authorize.commons.openOnThisDevice"),
            // The PUBLIC deep link only — it carries the `authorizeCode`, never
            // the secret finalize credential. An explicit user choice from the
            // disclosure, never an automatic route (a browser cannot verify that
            // a Commons app link resolves on this device). Withheld once the
            // request has failed: its handle is spent, so the link is a dead end.
            onPress: () => {
                window.location.href = qrPayload
            },
        })
    }
    alternatives.push({
        key: "commons-sign-in-here",
        label: t("authorize.commons.signInHere"),
        onPress: onSignInHere,
    })

    return (
        <AuthFormLayout>
            <AuthFormHeader
                title={
                    appName
                        ? t("authorize.title", { app: appName })
                        : t("authorize.requestTitle")
                }
                description={t("authorize.commons.description")}
            />

            {failed && failure !== null && (
                <p
                    className="rounded-radius-12 border border-destructive/50 bg-destructive/10 p-space-12 font-bodySmall text-bodySmall text-destructive"
                    data-testid="commons-failure"
                >
                    {t(FAILURE_KEYS[failure])}
                </p>
            )}

            <OxySignInRequestSurface
                route={snapshot.route}
                // `CommonsOAuthProgress` is a strict subset of the SDK's
                // `SignInProgress`; "nothing honest to report" is `'idle'`, which
                // renders no status line.
                progress={snapshot.progress ?? "idle"}
                qrPayload={qrPayload}
                failed={failed}
                // "Try again" means a BRAND-NEW request (`start` is a no-op on a
                // live one, and never re-finalizes a spent one), and is offered
                // only where a fresh attempt could actually land differently.
                onRetry={
                    failed && failure !== null && !UNRECOVERABLE_FAILURES.includes(failure)
                        ? request.start
                        : undefined
                }
                subordinate={[
                    {
                        key: "commons-cancel",
                        label: t("authorize.cancel"),
                        onPress: request.cancel,
                    },
                ]}
                alternatives={alternatives}
            />
        </AuthFormLayout>
    )
}
