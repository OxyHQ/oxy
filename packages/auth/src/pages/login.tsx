import { useCallback, useEffect, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { toast } from "@oxy.so/bloom/toast"
import { OxySignInPanel, OxySignUpPanel } from "@oxy.so/services"
import { postLoginRedirectFrom } from "@/lib/auth-utils"
import { useTranslation } from "@/lib/i18n/use-translation"
import { loginErrorKey } from "@/lib/login-errors"

/**
 * `/login` — the SDK's own sign-in screen, the one every Oxy app's account
 * dialog renders, and its account creation (`?screen=signup` starts there).
 * The IdP only decides where a sign-in continues: the request in the query
 * (`/authorize`, `/device`, `/mcp/link`).
 */
export function LoginPage() {
    const navigate = useNavigate()
    const [searchParams] = useSearchParams()
    const { t } = useTranslation()
    const [mode, setMode] = useState<"signin" | "signup">(searchParams.get("screen") === "signup" ? "signup" : "signin")

    // A failure a previous hop reported (`?error=<code>`), told once — only a
    // known code, as fixed copy; anything else in the query is ignored.
    const errorKey = loginErrorKey(searchParams.get("error"))
    useEffect(() => {
        if (errorKey) toast.error(t(errorKey))
    }, [errorKey, t])

    const onSignedIn = useCallback(() => navigate(postLoginRedirectFrom(searchParams)), [navigate, searchParams])

    if (mode === "signup") {
        return <OxySignUpPanel onSignedIn={onSignedIn} onSignIn={() => setMode("signin")} />
    }
    return (
        <OxySignInPanel
            onSignedIn={onSignedIn}
            onCreateAccount={() => setMode("signup")}
            loginHint={searchParams.get("login_hint") ?? undefined}
        />
    )
}
