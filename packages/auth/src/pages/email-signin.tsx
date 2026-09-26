import { useEffect, useState } from "react"
import { OxyAuthLoading, OxyAuthScreen, OxyAuthScreenHeader, useOxy } from "@oxy.so/services"
import { useTranslation } from "@/lib/i18n/use-translation"

/** What opening the email's link did. */
type LinkOutcome = "working" | "approved" | "other-device" | "invalid"

/** The API's code for a link opened in a browser that did not ask to sign in. */
const LINK_OTHER_DEVICE = "SIGNIN_LINK_OTHER_DEVICE"

/**
 * The link's one-use token, from the URL fragment (`#t=`): a fragment never
 * reaches a server, a referrer or an access log.
 */
export function readLinkToken(hash: string): string | null {
    const token = new URLSearchParams(hash.replace(/^#/, "")).get("t")
    return token && token.length > 0 ? token : null
}

/** Read the link's token and strip the fragment from the current history entry. */
export function takeLinkToken(): string | null {
    const token = readLinkToken(window.location.hash)
    if (window.location.hash) {
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`)
    }
    return token
}

/**
 * `/email-signin` — where the sign-in email's link lands.
 *
 * It approves the request with THIS browser's Oxy device, and only here: the
 * API approves a link only in the browser that asked to sign in (the app and
 * auth.oxy.so share that device through the bridge). It never signs this page
 * in — the app's screen, which holds the request's secret, collects the
 * session. Anywhere else it says to open the link where the sign-in started, or
 * type the code.
 *
 * The token is taken out of the address bar synchronously, as it is read, so
 * it is never left in history.
 */
export function EmailSignInPage() {
    const { t } = useTranslation()
    const { oxyServices, isAuthResolved } = useOxy()
    // Read once and taken out of the address bar in the same step, before
    // anything renders or runs with it in history.
    const [token] = useState(takeLinkToken)
    const [outcome, setOutcome] = useState<LinkOutcome>(token ? "working" : "invalid")

    // The device proof is this origin's persisted device, which the provider
    // exposes once its boot has run.
    useEffect(() => {
        if (!token || !isAuthResolved) return
        let cancelled = false
        const settle = (next: LinkOutcome) => {
            if (!cancelled) setOutcome(next)
        }
        ;(async () => {
            const device = await oxyServices.readDeviceProof()
            // No Oxy device in this browser: it is not the one that asked.
            if (!device) return settle("other-device")
            await oxyServices.approveEmailSignInLink(token, device)
            settle("approved")
        })().catch((error: unknown) => {
            const code = (error as { code?: unknown } | null)?.code
            settle(code === LINK_OTHER_DEVICE ? "other-device" : "invalid")
        })
        return () => {
            cancelled = true
        }
    }, [token, isAuthResolved, oxyServices])

    if (outcome === "working") return <OxyAuthLoading />

    const copy = {
        approved: [t("signin.link.approvedTitle"), t("signin.link.approvedDescription")],
        "other-device": [t("signin.link.otherDeviceTitle"), t("signin.link.otherDeviceDescription")],
        invalid: [t("signin.link.invalidTitle"), t("signin.link.invalidDescription")],
    }[outcome]

    return (
        <OxyAuthScreen>
            <div data-testid={`email-signin-${outcome}`}>
                <OxyAuthScreenHeader title={copy[0]} description={copy[1]} />
            </div>
        </OxyAuthScreen>
    )
}
