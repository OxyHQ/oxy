import { useNavigate, useSearchParams } from "react-router-dom"
import { OxyAuthLoading, OxyDeleteAccountPanel, OxySignInPanel, useOxy } from "@oxy.so/services"
import { withRequestQuery } from "@/lib/auth-utils"

/**
 * `/delete-account` — delete a passkey account (ADR 0029 D3). Its deletion is
 * confirmed with its passkey, which only this origin asserts, so an app's
 * "Delete account" opens this page. Signed out, the page signs in first; the
 * account deleted is the one signed in here.
 */
export function DeleteAccountPage() {
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
    return <OxyDeleteAccountPanel />
}
