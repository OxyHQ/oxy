import { useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useOxy } from "@oxy.so/services"
import { recoverSignedOut } from "@/lib/identity/carrier"
import { createPorts, messageOf } from "@/lib/identity/ports"
import { postLoginRedirectFrom, withRequestQuery } from "@/lib/auth-utils"
import { useTranslation } from "@/lib/i18n/use-translation"
import { IdentityWorking } from "@/components/identity/parts"
import { RecoveryForm } from "@/components/identity/recovery-form"

/**
 * `/recover` — get an account back with its recovery phrase (or the private
 * key an older identity was imported with), protected with a new passkey.
 * Recovery needs only the root (ADR 0024 D5). The recovered session becomes
 * THIS origin's and the page continues to the request in its query, so an
 * app that sent the person here gets them back signed in.
 */
export function RecoverPage() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [searchParams] = useSearchParams()
    const { handleWebSession } = useOxy()
    const [ports] = useState(createPorts)
    const [working, setWorking] = useState(false)
    const [error, setError] = useState<string | null>(null)

    if (working) return <IdentityWorking label={t("identity.continue.working.recovering")} />

    return (
        <RecoveryForm
            title={t("identity.recover.title")}
            description={t("identity.recover.desc")}
            submitLabel={t("identity.recover.action")}
            error={error}
            onBack={() => navigate(withRequestQuery("/login", searchParams))}
            onSubmit={(material) => {
                setError(null)
                setWorking(true)
                void (async () => {
                    const session = await recoverSignedOut(ports, material)
                    await handleWebSession(session.account.login)
                    navigate(postLoginRedirectFrom(searchParams), { replace: true })
                })().catch((reason: unknown) => {
                    setError(messageOf(reason, t))
                    setWorking(false)
                })
            }}
        />
    )
}
