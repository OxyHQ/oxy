import { Outlet, useLocation, useNavigationType } from "react-router-dom"
import { LanguagePicker } from "@/components/language-picker"

/**
 * The IdP's page: one centred column. Each screen draws its own header and
 * terms (the SDK's `OxyAuthScreen*`), exactly as the in-app account dialog does.
 */
export function AuthLayout() {
    const location = useLocation()
    const back = useNavigationType() === "POP"

    return (
        <div className="bg-background flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10 overflow-x-hidden">
            <div className="w-full max-w-[880px] flex flex-col gap-6">
                <div key={location.pathname} className={back ? "auth-step-back" : "auth-step-forward"}>
                    <Outlet />
                </div>
                <div className="flex justify-center">
                    <LanguagePicker />
                </div>
            </div>
        </div>
    )
}
