import { useCallback } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { OxyCreateAccountPanel } from "@oxy.so/services"
import { postLoginRedirectFrom, withRequestQuery } from "@/lib/auth-utils"

/**
 * `/signup` — create an Oxy account here, on the one origin that asserts Oxy
 * passkeys (ADR 0029 D3): a username, a recovery email confirmed with a code,
 * and a passkey. The SDK's own screen; the IdP only decides where it continues —
 * the request in its query, so an app that opened this page gets the person
 * back signed in.
 */
export function SignUpPage() {
    const navigate = useNavigate()
    const [searchParams] = useSearchParams()

    const onSignedIn = useCallback(
        () => navigate(postLoginRedirectFrom(searchParams), { replace: true }),
        [navigate, searchParams],
    )

    return (
        <OxyCreateAccountPanel
            onSignedIn={onSignedIn}
            onSignIn={() => navigate(withRequestQuery("/login", searchParams))}
        />
    )
}
