import { useCallback } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { OxyRecoverAccountPanel } from "@oxy.so/services"
import { postLoginRedirectFrom, withRequestQuery } from "@/lib/auth-utils"

/**
 * `/recover` — get a passkey account back (ADR 0029 D3): a code sent to its
 * recovery email, then a new passkey. The SDK's own screen; the recovered
 * session becomes THIS origin's and the page continues to the request in its
 * query, so an app that sent the person here gets them back signed in. An
 * account that uses Commons recovers in Commons, and the screen says so.
 */
export function RecoverPage() {
    const navigate = useNavigate()
    const [searchParams] = useSearchParams()

    const onRecovered = useCallback(
        () => navigate(postLoginRedirectFrom(searchParams), { replace: true }),
        [navigate, searchParams],
    )

    return (
        <OxyRecoverAccountPanel
            onRecovered={onRecovered}
            onSignIn={() => navigate(withRequestQuery("/login", searchParams))}
        />
    )
}
