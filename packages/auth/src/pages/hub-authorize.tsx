import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useSearchParams } from "react-router-dom"
import { buildSwitcherRows, projectDevicePrincipals } from "@oxyhq/core"
import type { PublicApplication, SwitcherContextRow } from "@oxyhq/core"
import type { DeviceDirectory } from "@oxyhq/contracts"
import { OxyConsentScreen, OxySignInRequestSurface, useOxy } from "@oxyhq/services"

import {
    AuthFormLayout,
    AuthFormHeader,
    LoadingSpinner,
} from "@/components/auth-form-layout"
import { AccountChooser } from "@/components/account-chooser"
import { useTranslation } from "@/lib/i18n/use-translation"
import { buildApiUrl, getAvatarUrl } from "@/lib/oxy-api-client"
import { safeRedirectUrl } from "@/lib/oauth-redirect"
import { deliverOAuthResult, type OAuthResult } from "@/lib/oauth-web-message"
import { hubClient, hubSessionOf } from "@/lib/hub-client"
import { HubEstablishRequest } from "@/lib/hub-establish"
import { OXY_CLIENT_ID } from "@/lib/oxy-client"

/**
 * `/authorize`, served by the BROWSER HUB (issue #937 Phase 5, ADR 0003).
 *
 * Routed only when `VITE_OXY_BROWSER_HUB=1`. With the flag off — the default,
 * and every build until somebody has actually run this in a browser — the
 * ordinary `AuthorizePage` is mounted instead and this file is never reached.
 *
 * ## What is different from the ordinary page, and why
 *
 * The ordinary page reads its session from the SDK: `useOxy().isAuthenticated`,
 * `oxyServices.getAccessToken()`, `useDeviceSwitcher()`. This one reads it from
 * the HUB, and holds no bearer at all — the device-wide access token stays at
 * the edge, which is why the code is minted by `POST /hub/authorize` rather than
 * by this page calling `POST /auth/oauth/authorize` itself.
 *
 * That is not a fallback order. With the flag on, `main.tsx` mounts the provider
 * with `deviceCredentialStorage="ephemeral"`, so this origin persists no
 * `{deviceId, deviceSecret}` and there is exactly ONE durable credential for the
 * browser profile: the server-side DeviceSession behind `__Host-oxy-device`.
 * "Try the hub, else localStorage" would be the dual authority the phase exists
 * to remove, and its failure mode is a revoked hub the browser silently
 * survives.
 *
 * ## The two lanes
 *
 * A browser the hub already knows goes straight to a code: resolve the session,
 * let the person pick a context if there is more than one, mint. No QR, no
 * password, no passkey ceremony — the headline of the phase.
 *
 * A browser it does not know runs ONE Commons approval that establishes the hub
 * (`lib/hub-establish.ts`), and then takes the first lane. Note this is a plain
 * `device_sign_in` request, not the OAuth-bound one the non-hub page uses: an
 * OAuth approval mints no session by design, so it could never establish a hub,
 * and a browser that joined that way would be back at a QR on the next origin.
 *
 * ## What this page never does
 *
 * It never navigates anywhere on its own, never opens a popup, never renders an
 * iframe, and refuses `prompt=none` before doing any work at all.
 */

/** Everything the OAuth request must carry for the hub lane to run. */
interface HubAuthorizeRequestParams {
    clientId: string
    redirectUri: string
    safeRedirectUri: string
    state: string | null
    codeChallenge: string
    scope: string | null
    responseMode: string | null
}

/**
 * Read and validate the request.
 *
 * S256 is required and `plain` is refused here rather than deeper in: the hub
 * lane exists to mint an authorization code, and a code bound to a challenge
 * this IdP does not accept is not a request it can serve. `null` means "this is
 * not a hub-servable request" and the caller says so plainly.
 */
function readRequest(params: URLSearchParams): HubAuthorizeRequestParams | null {
    const clientId = params.get("client_id")
    const redirectUri = params.get("redirect_uri")
    const codeChallenge = params.get("code_challenge")
    const method = params.get("code_challenge_method")
    if (!clientId || !redirectUri || !codeChallenge) return null
    if (method !== "S256") return null

    const safe = safeRedirectUrl(redirectUri)
    if (!safe) return null

    return {
        clientId,
        redirectUri,
        safeRedirectUri: safe,
        state: params.get("state"),
        codeChallenge,
        scope: params.get("scope"),
        responseMode: params.get("response_mode"),
    }
}

/**
 * Resolve the requesting application for display.
 *
 * Server-resolved from the registered `client_id`, exactly as the ordinary page
 * does it — never from anything the request author wrote.
 */
async function resolvePublicApplication(clientId: string): Promise<PublicApplication | null> {
    try {
        const response = await fetch(
            buildApiUrl(`/auth/oauth/client/${encodeURIComponent(clientId)}`)
        )
        if (!response.ok) return null
        const body = await response.json()
        const application = (body?.data ?? body)?.application
        return application && typeof application.id === "string"
            ? (application as PublicApplication)
            : null
    } catch {
        return null
    }
}

type Stage =
    | { kind: "loading" }
    | { kind: "unservable" }
    | { kind: "establish" }
    | { kind: "choose"; directory: DeviceDirectory }
    | { kind: "consent"; scopes: string[] }
    | { kind: "delivered" }
    | { kind: "error"; message: string }

export function HubAuthorizePage() {
    const [searchParams] = useSearchParams()
    // Decided above every other hook, and before any work: a refused silent
    // request performs no client lookup and no session read, so a third party
    // learns nothing about this browser from asking.
    if (searchParams.get("prompt") === "none") {
        return <SilentRefused />
    }
    return <HubAuthorizeRequest />
}

function SilentRefused() {
    const { t } = useTranslation()
    return (
        <AuthFormLayout>
            <AuthFormHeader
                title={t("authorize.silentUnsupportedTitle")}
                description={t("authorize.silentUnsupportedDesc")}
            />
        </AuthFormLayout>
    )
}

function HubAuthorizeRequest() {
    const { t } = useTranslation()
    const [searchParams] = useSearchParams()

    const request = useMemo(() => readRequest(searchParams), [searchParams])
    const [stage, setStage] = useState<Stage>({ kind: "loading" })
    const [application, setApplication] = useState<PublicApplication | null>(null)
    const [busy, setBusy] = useState(false)

    /** Hand the outcome to the relying party — popup post, or redirect. */
    const deliver = useCallback(
        (result: OAuthResult, safeRedirectUri: string, responseMode: string | null) => {
            deliverOAuthResult({ result, safeRedirectUri, responseMode, window })
            setStage({ kind: "delivered" })
        },
        []
    )

    /**
     * Ask the edge for a code. `approve` is only ever `true` when it came from
     * the consent screen's own button; the edge re-reads the consent decision
     * either way, so this flag can never be the thing that authorizes.
     */
    const mint = useCallback(
        async (approve: boolean) => {
            if (request === null) return
            setBusy(true)
            const outcome = await hubClient.authorize({
                clientId: request.clientId,
                redirectUri: request.redirectUri,
                ...(request.state === null ? {} : { state: request.state }),
                codeChallenge: request.codeChallenge,
                codeChallengeMethod: "S256",
                ...(request.scope === null ? {} : { scope: request.scope }),
                ...(approve ? { approve: true } : {}),
            })
            setBusy(false)

            if (outcome.status !== "ok") {
                setStage({ kind: "error", message: t("authorize.genericError") })
                return
            }
            const value = outcome.value
            if (value.status === "signed_out") {
                setStage({ kind: "establish" })
                return
            }
            if (value.status === "consent_required") {
                setStage({
                    kind: "consent",
                    scopes: request.scope ? request.scope.split(/\s+/).filter(Boolean) : [],
                })
                return
            }
            deliver(
                { kind: "code", code: value.code, state: value.state },
                request.safeRedirectUri,
                request.responseMode
            )
        },
        [request, deliver, t]
    )

    /** Boot: resolve the app for display, then ask the hub who this browser is. */
    useEffect(() => {
        if (request === null) {
            setStage({ kind: "unservable" })
            return
        }
        let cancelled = false

        void (async () => {
            const app = await resolvePublicApplication(request.clientId)
            if (cancelled) return
            setApplication(app)

            const session = hubSessionOf(await hubClient.session())
            if (cancelled) return
            if (session.status === "signed_out") {
                setStage({ kind: "establish" })
                return
            }
            // More than one `principal acting as account` pair is worth asking
            // about; a single one goes straight on.
            const contexts = session.directory.principals.reduce(
                (total, principal) => total + principal.contexts.length,
                0
            )
            if (contexts > 1) {
                setStage({ kind: "choose", directory: session.directory })
                return
            }
            await mint(false)
        })()

        return () => {
            cancelled = true
        }
    }, [request, mint])

    const onChoose = useCallback(
        async (context: SwitcherContextRow) => {
            setBusy(true)
            const outcome = context.isActive
                ? await hubClient.session()
                : await hubClient.activate(context.contextId)
            setBusy(false)
            if (hubSessionOf(outcome).status !== "active") {
                setStage({ kind: "establish" })
                return
            }
            await mint(false)
        },
        [mint]
    )

    if (request === null || stage.kind === "unservable") {
        return (
            <AuthFormLayout>
                <AuthFormHeader
                    title={t("authorize.requestTitle")}
                    description={t("authorize.invalidRequest")}
                />
            </AuthFormLayout>
        )
    }

    if (stage.kind === "establish") {
        return (
            <HubEstablishLane
                appName={application?.name ?? null}
                onEstablished={() => {
                    void mint(false)
                }}
            />
        )
    }

    if (stage.kind === "choose") {
        const rows = buildSwitcherRows(
            projectDevicePrincipals(stage.directory),
            stage.directory.activeContextId,
            (avatar) => (avatar ? getAvatarUrl(avatar) : undefined)
        )
        return (
            <AuthFormLayout>
                <AccountChooser
                    principals={rows}
                    appName={application?.name ?? null}
                    onSelectContext={(context) => {
                        void onChoose(context)
                    }}
                    onUseAnother={() => setStage({ kind: "establish" })}
                    isLoading={busy}
                />
            </AuthFormLayout>
        )
    }

    if (stage.kind === "consent" && application !== null) {
        return (
            <OxyConsentScreen
                application={application}
                scopes={stage.scopes}
                busy={busy}
                onAllow={() => {
                    void mint(true)
                }}
                onDeny={() =>
                    deliver(
                        { kind: "error", error: "access_denied", state: request.state },
                        request.safeRedirectUri,
                        request.responseMode
                    )
                }
            />
        )
    }

    if (stage.kind === "error") {
        return (
            <AuthFormLayout>
                <AuthFormHeader
                    title={t("authorize.requestTitle")}
                    description={stage.message}
                />
            </AuthFormLayout>
        )
    }

    return <LoadingSpinner />
}

/**
 * The fresh-browser lane: one Commons approval, which becomes this browser's
 * DeviceSession rather than a one-off code.
 */
function HubEstablishLane({
    appName,
    onEstablished,
}: {
    appName: string | null
    onEstablished: () => void
}) {
    const { t } = useTranslation()
    const { oxyServices } = useOxy()

    const request = useMemo(
        () =>
            new HubEstablishRequest(
                {
                    startCommonsSignIn: (params) => oxyServices.startCommonsSignIn(params),
                    pollSessionStatus: (sessionToken) =>
                        oxyServices.pollCommonsSignIn(sessionToken),
                    hub: hubClient,
                },
                OXY_CLIENT_ID
            ),
        [oxyServices]
    )

    useEffect(() => {
        void request.start()
        return () => request.cancel()
    }, [request])

    const snapshot = useSyncExternalStore(
        request.subscribe.bind(request),
        request.getSnapshot.bind(request),
        request.getSnapshot.bind(request)
    )

    useEffect(() => {
        if (snapshot.phase === "established") onEstablished()
    }, [snapshot.phase, onEstablished])

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
            <OxySignInRequestSurface
                route="qr"
                progress="idle"
                qrPayload={snapshot.qrPayload ?? undefined}
                failed={snapshot.phase === "failed"}
                // "Try again" is a BRAND-NEW request: the previous one's handle
                // is spent, and this instance never re-claims it.
                onRetry={undefined}
                subordinate={[]}
                alternatives={[]}
            />
        </AuthFormLayout>
    )
}
