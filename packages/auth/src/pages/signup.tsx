import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { Button } from "@oxy.so/bloom/button"
import { TextField, TextFieldInput, TextFieldLabel } from "@oxy.so/bloom/text-field"
import { useOxy } from "@oxy.so/services"
import type { OpenedWebIdentity } from "@oxy.so/core"
import { confirmPhrase, signUp, wipeIdentity, type CarrierSession } from "@/lib/identity/carrier"
import { createPorts, messageOf } from "@/lib/identity/ports"
import { postLoginRedirectFrom, withRequestQuery } from "@/lib/auth-utils"
import { useTranslation } from "@/lib/i18n/use-translation"
import { IdentityError, IdentityStep, IdentityWorking } from "@/components/identity/parts"
import { PhraseScreen } from "@/components/identity/phrase-screen"

type Stage =
    | { name: "start" }
    | { name: "working"; label: string }
    | { name: "phrase"; session: CarrierSession; identity: OpenedWebIdentity }

/**
 * `/signup` — create an Oxy account, here, on the one origin that may create
 * its root (ADR 0024 D4, ADR 0028): a username, a passkey that seals the new
 * identity, then the recovery phrase. The account's session becomes THIS
 * origin's (`handleWebSession`) and the page continues to the request in its
 * query — an app that sent the person here gets them back signed in.
 */
export function SignUpPage() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [searchParams] = useSearchParams()
    const { handleWebSession } = useOxy()
    const [ports] = useState(createPorts)
    const [stage, setStage] = useState<Stage>({ name: "start" })
    const [username, setUsername] = useState("")
    const [error, setError] = useState<string | null>(null)

    // An opened root lives only while its phrase is on screen.
    const openRef = useRef<OpenedWebIdentity | null>(null)
    useEffect(() => {
        const previous = openRef.current
        openRef.current = stage.name === "phrase" ? stage.identity : null
        if (previous && previous !== openRef.current) wipeIdentity(previous)
    }, [stage])
    useEffect(
        () => () => {
            if (openRef.current) wipeIdentity(openRef.current)
        },
        [],
    )

    const continueSignedIn = useCallback(
        async (session: CarrierSession) => {
            await handleWebSession(session.account.login)
            navigate(postLoginRedirectFrom(searchParams), { replace: true })
        },
        [handleWebSession, navigate, searchParams],
    )

    const create = () => {
        const handle = username.trim()
        if (handle.length < 3) return
        setError(null)
        setStage({ name: "working", label: t("identity.continue.working.creating") })
        void (async () => {
            if (!(await ports.api.isUsernameAvailable(handle))) throw new Error(t("identity.errors.usernameTaken"))
            const { session, identity } = await signUp(ports, handle)
            setStage({ name: "phrase", session, identity })
        })().catch((reason: unknown) => {
            setError(messageOf(reason, t))
            setStage({ name: "start" })
        })
    }

    switch (stage.name) {
        case "working":
            return <IdentityWorking label={stage.label} />
        case "phrase":
            return (
                <PhraseScreen
                    identity={stage.identity}
                    onConfirmed={async () => {
                        await confirmPhrase(ports, stage.session, stage.identity)
                        await continueSignedIn(stage.session)
                    }}
                    onLater={() => void continueSignedIn(stage.session)}
                />
            )
        default:
            return (
                <IdentityStep
                    title={t("identity.signup.title")}
                    description={t("identity.signup.desc")}
                    actions={
                        <>
                            <Button
                                appearance="solid"
                                tone="action"
                                size="lg"
                                fullWidth
                                disabled={username.trim().length < 3}
                                onPress={create}
                                testID="signup-create"
                            >
                                {t("identity.continue.createAccount")}
                            </Button>
                            <Button
                                appearance="plain"
                                tone="neutral"
                                size="lg"
                                fullWidth
                                onPress={() => navigate(withRequestQuery("/login", searchParams))}
                            >
                                {t("identity.signup.haveAccount")}
                            </Button>
                        </>
                    }
                >
                    <div className="flex flex-col gap-1.5">
                        <TextFieldLabel>{t("identity.continue.chooseUsername")}</TextFieldLabel>
                        <TextField radius={999}>
                            <TextFieldInput
                                label={t("identity.continue.chooseUsername")}
                                value={username}
                                onValueChange={setUsername}
                                onSubmitEditing={create}
                                autoComplete="username"
                                autoCapitalize="none"
                                spellCheck={false}
                                autoFocus
                                testID="signup-username"
                            />
                        </TextField>
                    </div>
                    <IdentityError message={error} />
                </IdentityStep>
            )
    }
}
