import { useEffect, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { Button } from "@oxy.so/bloom/button"
import { Checkbox } from "@oxy.so/bloom/checkbox"
import { TextField, TextFieldInput, TextFieldLabel } from "@oxy.so/bloom/text-field"
import type { CommonsApprovalInfo, OpenedWebIdentity } from "@oxy.so/core"
import {
    confirmPhrase,
    establishRoot,
    readIdentityStatus,
    recoverSignedOut,
    signIn,
    signUp,
    wipeIdentity,
    type CarrierSession,
    type IdentityStatus,
} from "@/lib/identity/carrier"
import { createPorts, messageOf } from "@/lib/identity/ports"
import { useTranslation } from "@/lib/i18n/use-translation"
import { IdentityError, IdentityNote, IdentityStep, IdentityText, IdentityWorking } from "@/components/identity/parts"
import { PhraseScreen } from "@/components/identity/phrase-screen"
import { RecoveryForm } from "@/components/identity/recovery-form"

/** The shape `POST /auth/session/create` mints: 16 random bytes, hex. */
const CODE_PATTERN = /^[0-9a-f]{32}$/

type Stage =
    | { name: "loading" }
    | { name: "blocked"; message: string }
    | { name: "start" }
    | { name: "recover" }
    | { name: "working"; label: string }
    | { name: "secure"; session: CarrierSession }
    | { name: "phrase"; session: CarrierSession; identity: OpenedWebIdentity }
    | { name: "confirm"; session: CarrierSession; status: IdentityStatus | null; recovered?: boolean }
    | { name: "done" }

/**
 * `/continue?user_code=…` — sign in to the app that opened this window.
 *
 * The app created a device-flow request and opened this page with its authorize
 * code; this page signs the person in with a passkey — creating the account WITH
 * its root, or recovering it from the recovery phrase — and then authorizes THAT
 * request, which the app claims through its existing poll/socket. The parameter
 * is `user_code`, never `code`: `OxyProvider`'s cold boot reads a `?code=` as an
 * OAuth return and strips it.
 *
 * It runs on its own client (`lib/identity/`), not this origin's `OxyProvider`
 * session: the session it signs in exists only to authorize the request, and is
 * signed out once it has.
 *
 * Signing in opens nothing (ADR 0024 D3): the note about the account's identity
 * comes from metadata. A root is opened only to create one, to confirm the phrase,
 * or when a legacy account without one chooses to finish securing itself.
 *
 * SECURITY — the authorize call fires ONLY from an explicit press on a screen
 * naming the application and the account, behind an unchecked-by-default
 * acknowledgement, so a crafted code from an attacker's own app cannot be
 * authorized by a single tap.
 */
export function ContinuePage() {
    const { t } = useTranslation()
    const [searchParams] = useSearchParams()
    const rawCode = searchParams.get("user_code")
    const code = rawCode && CODE_PATTERN.test(rawCode) ? rawCode : null
    const [ports] = useState(createPorts)
    const [approval, setApproval] = useState<CommonsApprovalInfo | null>(null)
    const [stage, setStage] = useState<Stage>({ name: "loading" })
    const [username, setUsername] = useState("")
    const [creating, setCreating] = useState(false)
    const [acknowledged, setAcknowledged] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const hasOpener = typeof window !== "undefined" && window.opener != null

    // An opened root lives only while its screen is visible.
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

    useEffect(() => {
        if (!code) return
        let cancelled = false
        ports.api
            .approvalInfo(code)
            .then(({ info, blockingReason }) => {
                if (cancelled) return
                if (blockingReason) setStage({ name: "blocked", message: blockingReason })
                else {
                    setApproval(info)
                    setStage({ name: "start" })
                }
            })
            .catch((reason: unknown) => {
                if (!cancelled) setStage({ name: "blocked", message: messageOf(reason, t) })
            })
        return () => {
            cancelled = true
        }
    }, [code, ports, t])

    const appName = approval?.application?.name

    async function afterSignIn(session: CarrierSession) {
        setStage({ name: "working", label: t("identity.continue.working.signingIn") })
        const status = await readIdentityStatus(ports, session)
        if (status.kind === "no-root") {
            setStage({ name: "secure", session })
            return
        }
        setStage({ name: "confirm", session, status })
    }

    /** Run a step; on failure return to the stage it started from, with the reason shown. */
    function run(label: string, task: () => Promise<void>, from: Stage = stage) {
        setError(null)
        setStage({ name: "working", label })
        task().catch((reason: unknown) => {
            setError(messageOf(reason, t))
            setStage(from)
        })
    }

    function cancel() {
        if (code) void ports.api.denyCode(code).catch(() => undefined)
        window.close()
    }

    if (!hasOpener || !code) {
        return <IdentityStep title={t("identity.continue.noOpenerTitle")} description={t("identity.continue.noOpenerDesc")} />
    }

    const cancelButton = (
        <Button appearance="plain" tone="neutral" size="lg" fullWidth onPress={cancel}>
            {t("identity.common.cancel")}
        </Button>
    )

    switch (stage.name) {
        case "loading":
            return <IdentityWorking label={t("identity.common.loading")} />
        case "blocked":
            return <IdentityStep title={t("identity.continue.blockedTitle")} description={stage.message} />
        case "working":
            return <IdentityWorking label={stage.label} />
        case "recover":
            return (
                <RecoveryForm
                    title={t("identity.recover.title")}
                    description={t("identity.recover.desc")}
                    submitLabel={t("identity.recover.action")}
                    error={error}
                    onBack={() => {
                        setError(null)
                        setStage({ name: "start" })
                    }}
                    onSubmit={(material) =>
                        run(
                            t("identity.continue.working.recovering"),
                            async () => {
                                const session = await recoverSignedOut(ports, material)
                                const status = await readIdentityStatus(ports, session)
                                setStage({ name: "confirm", session, status, recovered: true })
                            },
                            { name: "recover" },
                        )
                    }
                />
            )
        case "secure":
            return (
                <IdentityStep
                    title={t("identity.secure.title")}
                    description={t("identity.secure.desc")}
                    actions={
                        <>
                            <Button
                                appearance="solid"
                                tone="action"
                                size="lg"
                                fullWidth
                                onPress={() =>
                                    run(t("identity.continue.working.securing"), async () => {
                                        const { identity } = await establishRoot(ports, stage.session)
                                        setStage({ name: "phrase", session: stage.session, identity })
                                    })
                                }
                            >
                                {t("identity.secure.action")}
                            </Button>
                            <Button
                                appearance="plain"
                                tone="neutral"
                                size="lg"
                                fullWidth
                                onPress={() => setStage({ name: "confirm", session: stage.session, status: { kind: "no-root" } })}
                            >
                                {t("identity.secure.notNow")}
                            </Button>
                        </>
                    }
                >
                    <IdentityError message={error} />
                </IdentityStep>
            )
        case "phrase":
            return (
                <PhraseScreen
                    identity={stage.identity}
                    onConfirmed={async () => {
                        const status = await confirmPhrase(ports, stage.session, stage.identity)
                        setStage({ name: "confirm", session: stage.session, status })
                    }}
                    onLater={() => {
                        void readIdentityStatus(ports, stage.session)
                            .then((status) => setStage({ name: "confirm", session: stage.session, status }))
                            .catch(() => setStage({ name: "confirm", session: stage.session, status: null }))
                    }}
                />
            )
        case "confirm": {
            const account = stage.session.account
            const app = appName ?? t("identity.continue.thisApp")
            return (
                <IdentityStep
                    title={t("identity.continue.confirmTitle", { app })}
                    description={t("identity.continue.confirmAs", { handle: account.username ?? account.userId })}
                    actions={
                        <>
                            <Button
                                appearance="solid"
                                tone="action"
                                size="lg"
                                fullWidth
                                disabled={!acknowledged}
                                onPress={() =>
                                    run(t("identity.continue.working.signingIn"), async () => {
                                        await ports.api.authorizeCode(code)
                                        await ports.api.signOut(account.sessionId).catch(() => undefined)
                                        setStage({ name: "done" })
                                        window.setTimeout(() => window.close(), 800)
                                    })
                                }
                                testID="continue-authorize"
                            >
                                {t("identity.common.continue")}
                            </Button>
                            {cancelButton}
                        </>
                    }
                >
                    {stage.recovered ? <IdentityText>{t("identity.continue.recovered")}</IdentityText> : null}
                    <StatusNote status={stage.status} />
                    <Checkbox
                        checked={acknowledged}
                        onCheckedChange={setAcknowledged}
                        label={approval?.originVerified ? t("identity.continue.ackVerified", { app }) : t("identity.continue.ackUnverified")}
                        testID="continue-ack"
                    />
                    <IdentityError message={error} />
                </IdentityStep>
            )
        }
        case "done":
            return <IdentityStep title={t("identity.continue.doneTitle")} description={t("identity.common.closeWindow")} />
        default:
            return (
                <IdentityStep
                    title={t("identity.continue.title", { app: appName ?? t("identity.continue.theApp") })}
                    description={t("identity.continue.subtitle")}
                    actions={
                        <>
                            <Button
                                appearance="solid"
                                tone="action"
                                size="lg"
                                fullWidth
                                onPress={() => run(t("identity.continue.working.passkey"), async () => afterSignIn(await signIn(ports)))}
                                testID="continue-passkey"
                            >
                                {t("identity.continue.withPasskey")}
                            </Button>
                            {creating ? null : (
                                <Button appearance="plain" tone="neutral" size="lg" fullWidth onPress={() => setCreating(true)}>
                                    {t("identity.continue.createLink")}
                                </Button>
                            )}
                            <Button
                                appearance="plain"
                                tone="neutral"
                                size="lg"
                                fullWidth
                                onPress={() => {
                                    setError(null)
                                    setStage({ name: "recover" })
                                }}
                            >
                                {t("identity.continue.recoverLink")}
                            </Button>
                            {cancelButton}
                        </>
                    }
                >
                    <IdentityError message={error} />
                    {creating ? (
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1.5">
                                <TextFieldLabel>{t("identity.continue.chooseUsername")}</TextFieldLabel>
                                <TextField radius={999}>
                                    <TextFieldInput
                                        label={t("identity.continue.chooseUsername")}
                                        value={username}
                                        onValueChange={setUsername}
                                        autoComplete="username"
                                        autoCapitalize="none"
                                        spellCheck={false}
                                        testID="continue-username"
                                    />
                                </TextField>
                            </div>
                            <Button
                                appearance="outline"
                                tone="neutral"
                                size="lg"
                                fullWidth
                                disabled={username.trim().length < 3}
                                onPress={() => {
                                    const handle = username.trim()
                                    run(t("identity.continue.working.creating"), async () => {
                                        if (!(await ports.api.isUsernameAvailable(handle))) throw new Error(t("identity.errors.usernameTaken"))
                                        const { session, identity } = await signUp(ports, handle)
                                        setStage({ name: "phrase", session, identity })
                                    })
                                }}
                                testID="continue-create"
                            >
                                {t("identity.continue.createAccount")}
                            </Button>
                        </div>
                    ) : null}
                </IdentityStep>
            )
    }
}

function StatusNote({ status }: { status: IdentityStatus | null }) {
    const { t } = useTranslation()
    if (!status) return null
    switch (status.kind) {
        case "ready":
            return status.hasPhrase && !status.phraseConfirmedAt ? <IdentityNote>{t("identity.note.phraseNotSaved")}</IdentityNote> : null
        case "elsewhere":
            return <IdentityNote>{t("identity.note.elsewhere")}</IdentityNote>
        case "no-root":
            return <IdentityNote>{t("identity.note.noRoot")}</IdentityNote>
    }
}
