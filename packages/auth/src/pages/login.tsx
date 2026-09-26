import { useCallback, useRef } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { toast } from "@oxy.so/bloom/toast"
import { OxySignInPanel } from "@oxy.so/services"
import { postLoginRedirectFrom, withRequestQuery } from "@/lib/auth-utils"

/**
 * `/login` — the SDK's own sign-in screen, the one every Oxy app's account
 * dialog renders. The IdP only decides where a sign-in continues: the request
 * in the query (`/authorize`, `/device`, `/mcp/link`).
 */
export function LoginPage() {
    const navigate = useNavigate()
    const [searchParams] = useSearchParams()

    // A failure a previous hop reported (`?error=`), told once.
    const error = searchParams.get("error")
    const errorShown = useRef(false)
    if (error && !errorShown.current) {
        errorShown.current = true
        queueMicrotask(() => toast.error(error))
    }

    const onSignedIn = useCallback(() => navigate(postLoginRedirectFrom(searchParams)), [navigate, searchParams])

    return (
        <OxySignInPanel
            onSignedIn={onSignedIn}
            onCreateAccount={() => navigate(withRequestQuery("/signup", searchParams))}
            onRecover={() => navigate(withRequestQuery("/recover", searchParams))}
            loginHint={searchParams.get("login_hint") ?? undefined}
        />
    )
}
