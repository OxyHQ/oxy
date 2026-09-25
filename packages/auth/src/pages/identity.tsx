import { useEffect, useRef, useState } from "react"
import { Button } from "@oxy.so/bloom/button"
import { TextField, TextFieldInput, TextFieldLabel } from "@oxy.so/bloom/text-field"
import type { OpenedWebIdentity } from "@oxy.so/core"
import {
    confirmPhrase,
    deleteAccount,
    establishRoot,
    openRootForDisplay,
    readIdentityStatus,
    recoverSignedOut,
    resealFromMaterial,
    signIn,
    wipeIdentity,
    type CarrierSession,
    type IdentityStatus,
} from "@/lib/identity/carrier"
import { createPorts, messageOf } from "@/lib/identity/ports"
import { useTranslation } from "@/lib/i18n/use-translation"
import { MoveFlow } from "@/components/identity/move-flow"
import { IdentityError, IdentityNote, IdentityStep, IdentityText, IdentityWorking } from "@/components/identity/parts"
import { PhraseScreen } from "@/components/identity/phrase-screen"
import { RecoveryForm } from "@/components/identity/recovery-form"

type View =
    | { name: "signed-out" }
    | { name: "recover-signed-out" }
    | { name: "working"; label: string }
    | { name: "overview"; session: CarrierSession; status: IdentityStatus }
    | { name: "phrase"; session: CarrierSession; identity: OpenedWebIdentity }
    | { name: "recover"; session: CarrierSession }
    | { name: "delete"; session: CarrierSession }
    | { name: "move"; session: CarrierSession }
    | { name: "deleted" }

/**
 * `/identity` — the person's Oxy identity: saving the recovery phrase,
 * recovering, giving it to Commons (`/identity/move` goes straight there),
 * deleting the account. Every one of these opens the root with a fresh passkey
 * ceremony, for that operation only; signing in opens nothing.
 *
 * Like `/continue` it runs on its own client (`lib/identity/`), not this
 * origin's `OxyProvider` session.
 */
export function IdentityPage({ intent = "overview" }: { intent?: "overview" | "move" }) {
    const { t } = useTranslation()
    const [ports] = useState(createPorts)
    const [view, setView] = useState<View>({ name: "signed-out" })
    const [error, setError] = useState<string | null>(null)
    const [confirmText, setConfirmText] = useState("")
    const intentRef = useRef(intent)

    // An opened root lives only while the phrase is on screen.
    const openRef = useRef<OpenedWebIdentity | null>(null)
    useEffect(() => {
        const previous = openRef.current
        openRef.current = view.name === "phrase" ? view.identity : null
        if (previous && previous !== openRef.current) wipeIdentity(previous)
    }, [view])
    useEffect(
        () => () => {
            if (openRef.current) wipeIdentity(openRef.current)
        },
        [],
    )

    function run(label: string, task: () => Promise<void>, from: View = view) {
        setError(null)
        setView({ name: "working", label })
        task().catch((reason: unknown) => {
            setError(messageOf(reason, t))
            setView(from)
        })
    }

    async function refresh(session: CarrierSession) {
        const status = await readIdentityStatus(ports, session)
        if (intentRef.current === "move" && status.kind === "ready") setView({ name: "move", session })
        else setView({ name: "overview", session, status })
        intentRef.current = "overview"
    }

    const button = (label: string, onPress: () => void, kind: "solid" | "outline" | "plain" = "outline", testID?: string) => (
        <Button
            appearance={kind}
            tone={kind === "solid" ? "action" : "neutral"}
            size="lg"
            fullWidth
            onPress={onPress}
            testID={testID}
        >
            {label}
        </Button>
    )

    switch (view.name) {
        case "signed-out":
            return (
                <IdentityStep
                    title={t("identity.home.title")}
                    description={t("identity.home.desc")}
                    actions={
                        <>
                            {button(
                                t("identity.home.signIn"),
                                () => run(t("identity.continue.working.passkey"), async () => refresh(await signIn(ports))),
                                "solid",
                                "identity-sign-in",
                            )}
                            {button(
                                t("identity.continue.recoverLink"),
                                () => {
                                    setError(null)
                                    setView({ name: "recover-signed-out" })
                                },
                                "plain",
                            )}
                        </>
                    }
                >
                    <IdentityError message={error} />
                </IdentityStep>
            )
        case "recover-signed-out":
            return (
                <RecoveryForm
                    title={t("identity.recover.title")}
                    description={t("identity.recover.desc")}
                    submitLabel={t("identity.recover.action")}
                    error={error}
                    onBack={() => setView({ name: "signed-out" })}
                    onSubmit={(material) =>
                        run(t("identity.continue.working.recovering"), async () => refresh(await recoverSignedOut(ports, material)), {
                            name: "recover-signed-out",
                        })
                    }
                />
            )
        case "working":
            return <IdentityWorking label={view.label} />
        case "phrase":
            return (
                <PhraseScreen
                    identity={view.identity}
                    onConfirmed={async () => {
                        await confirmPhrase(ports, view.session, view.identity)
                        await refresh(view.session)
                    }}
                    onLater={() => void refresh(view.session)}
                />
            )
        case "recover":
            return (
                <RecoveryForm
                    title={t("identity.recover.resealTitle")}
                    description={t("identity.recover.resealDesc")}
                    submitLabel={t("identity.common.continue")}
                    error={error}
                    onBack={() => void refresh(view.session)}
                    onSubmit={(material) =>
                        run(
                            t("identity.recover.working"),
                            async () => {
                                await resealFromMaterial(ports, view.session, material)
                                await refresh(view.session)
                            },
                            { name: "recover", session: view.session },
                        )
                    }
                />
            )
        case "delete": {
            const handle = view.session.account.username
            return (
                <IdentityStep
                    title={t("identity.delete.title")}
                    description={t("identity.delete.desc", { handle: handle ?? "" })}
                    actions={
                        <>
                            <Button
                                appearance="solid"
                                tone="danger"
                                size="lg"
                                fullWidth
                                disabled={confirmText !== handle}
                                onPress={() =>
                                    run(t("identity.delete.working"), async () => {
                                        await deleteAccount(ports, view.session, confirmText)
                                        setView({ name: "deleted" })
                                    })
                                }
                                testID="identity-delete-confirm"
                            >
                                {t("identity.delete.action")}
                            </Button>
                            {button(t("identity.common.cancel"), () => void refresh(view.session), "plain")}
                        </>
                    }
                >
                    <div className="flex flex-col gap-1.5">
                        <TextFieldLabel>{t("identity.delete.confirmField")}</TextFieldLabel>
                        <TextField radius={999}>
                            <TextFieldInput
                                label={t("identity.delete.confirmField")}
                                value={confirmText}
                                onValueChange={setConfirmText}
                                autoCapitalize="none"
                                autoComplete="off"
                                spellCheck={false}
                            />
                        </TextField>
                    </div>
                    <IdentityError message={error} />
                </IdentityStep>
            )
        }
        case "move":
            return <MoveFlow ports={ports} session={view.session} onDone={() => run(t("identity.common.loading"), () => refresh(view.session))} />
        case "deleted":
            return <IdentityStep title={t("identity.delete.doneTitle")} description={t("identity.common.closeWindow")} />
        case "overview": {
            const { session, status } = view
            return (
                <IdentityStep
                    title={`@${session.account.username}`}
                    actions={
                        <>
                            {status.kind === "ready" && status.hasPhrase
                                ? button(
                                      status.phraseConfirmedAt ? t("identity.home.showPhrase") : t("identity.home.savePhrase"),
                                      () =>
                                          run(t("identity.home.opening"), async () =>
                                              setView({ name: "phrase", session, identity: await openRootForDisplay(ports, session) }),
                                          ),
                                      status.phraseConfirmedAt ? "outline" : "solid",
                                  )
                                : null}
                            {status.kind === "ready" && status.hasPhrase
                                ? button(t("identity.home.toCommons"), () => setView({ name: "move", session }))
                                : null}
                            {status.kind === "no-root"
                                ? button(
                                      t("identity.secure.action"),
                                      () =>
                                          run(t("identity.continue.working.securing"), async () => {
                                              const { identity } = await establishRoot(ports, session)
                                              setView({ name: "phrase", session, identity })
                                          }),
                                      "solid",
                                  )
                                : null}
                            {button(
                                status.kind === "elsewhere" ? t("identity.home.keepHereToo") : t("identity.home.usePhrase"),
                                () => setView({ name: "recover", session }),
                            )}
                            {status.kind === "ready" ? (
                                <Button appearance="plain" tone="danger" size="lg" fullWidth onPress={() => setView({ name: "delete", session })}>
                                    {t("identity.home.delete")}
                                </Button>
                            ) : null}
                        </>
                    }
                >
                    <StatusSummary status={status} />
                    <IdentityError message={error} />
                </IdentityStep>
            )
        }
    }
}

function StatusSummary({ status }: { status: IdentityStatus }) {
    const { t } = useTranslation()
    switch (status.kind) {
        case "ready":
            if (!status.hasPhrase) return <IdentityText>{t("identity.home.status.readyNoPhrase")}</IdentityText>
            return status.phraseConfirmedAt ? (
                <IdentityText>{t("identity.home.status.readySaved")}</IdentityText>
            ) : (
                <IdentityNote>{t("identity.home.status.readyUnsaved")}</IdentityNote>
            )
        case "elsewhere":
            return <IdentityText>{t("identity.home.status.elsewhere")}</IdentityText>
        case "no-root":
            return <IdentityNote>{t("identity.home.status.noRoot")}</IdentityNote>
    }
}
