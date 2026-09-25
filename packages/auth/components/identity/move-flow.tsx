import { useEffect, useRef, useState } from "react"
import QRCode from "react-native-qrcode-svg"
import { Button } from "@oxy.so/bloom/button"
import { Checkbox } from "@oxy.so/bloom/checkbox"
import { useTheme } from "@oxy.so/bloom/theme"
import { Text } from "@oxy.so/bloom/typography"
import { buildMoveQrPayload } from "@oxy.so/core"
import type { IdentityMoveState } from "@oxy.so/contracts"
import {
    cancelMove,
    completeMove,
    readMove,
    sendMove,
    startMove,
    type CarrierPorts,
    type CarrierSession,
    type OutgoingMove,
} from "@/lib/identity/carrier"
import { messageOf } from "@/lib/identity/ports"
import { useTranslation } from "@/lib/i18n/use-translation"
import { IdentityError, IdentityNote, IdentityStep, IdentityText, IdentityWorking } from "./parts"

const POLL_MS = 2000
/** Fixed contrast for scan reliability, never themed. */
const QR_SIZE = 220

type Step =
    | { name: "intro" }
    | { name: "working"; label: string }
    | { name: "scan"; move: OutgoingMove }
    | { name: "compare"; move: OutgoingMove; sas: string }
    | { name: "sent"; move: OutgoingMove }
    | { name: "moved" }
    | { name: "ended"; reason: "expired" | "cancelled" }

/**
 * Give this account's identity to the Commons app (ADR 0024 D6).
 *
 * Two intentions: ADD Commons and keep this browser as well, or keep the
 * identity ONLY in Commons. Either way the browser shows a code, Commons scans
 * it, both screens show the same six digits, and only after the person confirms
 * they match is the identity sealed for that phone. The browser copy is removed
 * — when that was chosen — only once Commons proves, with a signature this page
 * checks itself, that it holds the identity.
 */
export function MoveFlow({ ports, session, onDone }: { ports: CarrierPorts; session: CarrierSession; onDone: () => void }) {
    const { t } = useTranslation()
    const theme = useTheme()
    const [step, setStep] = useState<Step>({ name: "intro" })
    const [error, setError] = useState<string | null>(null)
    const [keepWebHolder, setKeepWebHolder] = useState(true)
    const moveRef = useRef<OutgoingMove | null>(null)

    const fail = (reason: unknown) => {
        setError(messageOf(reason, t))
        setStep({ name: "intro" })
    }

    // Poll while a move is under way. One request at a time; each step decides
    // what it is waiting for, and completing is handled outside the poll so its
    // failure is always shown.
    useEffect(() => {
        if (step.name !== "scan" && step.name !== "sent") return
        const { move } = step
        let stopped = false
        let timer: number | undefined

        const tick = async () => {
            try {
                const { state, progress } = await readMove(ports, move)
                if (stopped) return
                if (progress.kind === "compare" && step.name === "scan") {
                    setStep({ name: "compare", move, sas: progress.sas })
                    return
                }
                if (progress.kind === "received") {
                    stopped = true
                    void finish(move, state)
                    return
                }
                if (progress.kind === "ended") {
                    moveRef.current = null
                    setStep({ name: "ended", reason: progress.reason })
                    return
                }
            } catch (reason) {
                if (stopped) return
                fail(reason)
                return
            }
            if (!stopped) timer = window.setTimeout(() => void tick(), POLL_MS)
        }
        timer = window.setTimeout(() => void tick(), POLL_MS)
        return () => {
            stopped = true
            window.clearTimeout(timer)
        }
        // `finish` and `fail` read only state setters and the props below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ports, session, step])

    // Leaving the page mid-move cancels it rather than leaving a live code behind.
    useEffect(
        () => () => {
            const move = moveRef.current
            if (move) void cancelMove(ports, move).catch(() => undefined)
        },
        [ports],
    )

    async function begin() {
        setError(null)
        setStep({ name: "working", label: t("identity.move.preparing") })
        try {
            const move = await startMove(ports, session)
            moveRef.current = move
            setStep({ name: "scan", move })
        } catch (reason) {
            fail(reason)
        }
    }

    async function finish(move: OutgoingMove, state: IdentityMoveState) {
        setStep({ name: "working", label: keepWebHolder ? t("identity.move.finishing") : t("identity.move.finishingRemove") })
        try {
            await completeMove(ports, session, move, state, { keepWebHolder })
            moveRef.current = null
            setStep({ name: "moved" })
        } catch (reason) {
            // The web copy is intact: a receipt that does not verify destroys nothing.
            fail(reason)
        }
    }

    async function confirm(move: OutgoingMove, sas: string) {
        setError(null)
        setStep({ name: "working", label: t("identity.move.sending") })
        try {
            await sendMove(ports, session, move, sas)
            setStep({ name: "sent", move })
        } catch (reason) {
            moveRef.current = null
            await cancelMove(ports, move).catch(() => undefined)
            fail(reason)
        }
    }

    async function stop(move: OutgoingMove) {
        moveRef.current = null
        await cancelMove(ports, move).catch(() => undefined)
        setStep({ name: "ended", reason: "cancelled" })
    }

    const back = (
        <Button appearance="plain" tone="neutral" size="lg" fullWidth onPress={onDone}>
            {t("identity.common.back")}
        </Button>
    )

    switch (step.name) {
        case "intro":
            return (
                <IdentityStep
                    title={t("identity.move.introTitle")}
                    description={t("identity.move.introDesc")}
                    actions={
                        <>
                            <Button appearance="solid" tone="action" size="lg" fullWidth onPress={() => void begin()}>
                                {t("identity.move.showCode")}
                            </Button>
                            {back}
                        </>
                    }
                >
                    <Checkbox checked={!keepWebHolder} onCheckedChange={(checked) => setKeepWebHolder(!checked)} label={t("identity.move.onlyCommons")} />
                    <IdentityText>{t("identity.move.haveCommons")}</IdentityText>
                    <IdentityError message={error} />
                </IdentityStep>
            )
        case "working":
            return <IdentityWorking label={step.label} />
        case "scan":
            return (
                <IdentityStep
                    title={t("identity.move.scanTitle")}
                    description={t("identity.move.scanDesc")}
                    actions={
                        <Button appearance="plain" tone="neutral" size="lg" fullWidth onPress={() => void stop(step.move)}>
                            {t("identity.common.cancel")}
                        </Button>
                    }
                >
                    {/* The code carries only the move id. */}
                    <div className="self-center rounded-2xl bg-white p-3" role="img" aria-label={t("identity.move.scanTitle")}>
                        <QRCode value={buildMoveQrPayload(step.move.moveId)} size={QR_SIZE} backgroundColor="#FFFFFF" color="#000000" />
                    </div>
                    <IdentityNote>{t("identity.move.scanNote")}</IdentityNote>
                </IdentityStep>
            )
        case "compare":
            return (
                <IdentityStep
                    title={t("identity.move.compareTitle")}
                    description={t("identity.move.compareDesc")}
                    actions={
                        <>
                            <Button appearance="solid" tone="action" size="lg" fullWidth onPress={() => void confirm(step.move, step.sas)}>
                                {t("identity.move.match")}
                            </Button>
                            <Button appearance="outline" tone="neutral" size="lg" fullWidth onPress={() => void stop(step.move)}>
                                {t("identity.move.noMatch")}
                            </Button>
                        </>
                    }
                >
                    <Text
                        accessibilityLabel={step.sas.split("").join(" ")}
                        style={{ fontFamily: "ui-monospace, monospace", fontSize: 40, letterSpacing: 4, textAlign: "center", color: theme.colors.text }}
                    >
                        {step.sas.slice(0, 3)} {step.sas.slice(3)}
                    </Text>
                    <IdentityError message={error} />
                </IdentityStep>
            )
        case "sent":
            return <IdentityStep title={t("identity.move.sentTitle")} description={t("identity.move.sentDesc")} />
        case "moved":
            return (
                <IdentityStep
                    title={t("identity.move.movedTitle")}
                    description={keepWebHolder ? t("identity.move.movedKept") : t("identity.move.movedOnly")}
                    actions={
                        <Button appearance="solid" tone="action" size="lg" fullWidth onPress={onDone}>
                            {t("identity.common.done")}
                        </Button>
                    }
                />
            )
        case "ended":
            return (
                <IdentityStep
                    title={step.reason === "expired" ? t("identity.move.expiredTitle") : t("identity.move.cancelledTitle")}
                    description={t("identity.move.endedDesc")}
                    actions={
                        <>
                            <Button appearance="solid" tone="action" size="lg" fullWidth onPress={() => void begin()}>
                                {t("identity.move.again")}
                            </Button>
                            {back}
                        </>
                    }
                />
            )
    }
}
