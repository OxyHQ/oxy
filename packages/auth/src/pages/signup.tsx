import { useCallback } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { OxySignUpPanel } from "@oxy.so/services"
import { postLoginRedirectFrom, withRequestQuery } from "@/lib/auth-utils"

/** `/signup` — the SDK's account-creation screen; the new account continues to the request in the query. */
export function SignUpPage() {
    const navigate = useNavigate()
    const [searchParams] = useSearchParams()
    const onSignedIn = useCallback(() => navigate(postLoginRedirectFrom(searchParams)), [navigate, searchParams])

    return (
        <OxySignUpPanel
            onSignedIn={onSignedIn}
            onSignIn={() => navigate(withRequestQuery("/login", searchParams))}
        />
    )
}
