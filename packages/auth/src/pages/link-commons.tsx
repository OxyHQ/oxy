import { useNavigate, useSearchParams } from "react-router-dom"
import { OxyAuthLoading, OxyLinkCommonsPanel, OxySignInPanel, useOxy } from "@oxy.so/services"
import { withRequestQuery } from "@/lib/auth-utils"

/**
 * `/link-commons` — link Commons to a passkey account (ADR 0029 D3): a QR
 * Commons scans and signs, then a passkey assertion here, where Oxy passkeys
 * are asserted. The account becomes self-custodied and its recovery email is
 * deleted. Signed out, the page signs in first; the account linked is the one
 * signed in here. Accounts' security settings open this page.
 */
export function LinkCommonsPage() {
    const navigate = useNavigate()
    const [searchParams] = useSearchParams()
    const { isAuthenticated, isAuthResolved } = useOxy()

    if (!isAuthResolved) return <OxyAuthLoading />
    if (!isAuthenticated) {
        return (
            <OxySignInPanel
                onSignedIn={() => undefined}
                onCreateAccount={() => navigate(withRequestQuery("/signup", searchParams))}
                onRecover={() => navigate(withRequestQuery("/recover", searchParams))}
            />
        )
    }
    return <OxyLinkCommonsPanel />
}
