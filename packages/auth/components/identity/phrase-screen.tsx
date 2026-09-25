import { useMemo, useState } from "react"
import { Button } from "@oxy.so/bloom/button"
import { TextField, TextFieldInput, TextFieldLabel } from "@oxy.so/bloom/text-field"
import { useTheme } from "@oxy.so/bloom/theme"
import type { OpenedWebIdentity } from "@oxy.so/core"
import { pickConfirmationPositions } from "@/lib/identity/carrier"
import { useTranslation } from "@/lib/i18n/use-translation"
import { IdentityError, IdentityStep } from "./parts"

/**
 * Show the recovery phrase, then ask for three of the words back.
 *
 * "I saved it" is demonstrated, not clicked: the phrase is the only way to get
 * an identity back when every device and passkey is gone, and nobody — Oxy
 * included — can reset it.
 */
export function PhraseScreen({
    identity,
    onConfirmed,
    onLater,
}: {
    identity: OpenedWebIdentity
    /** Called after the person typed back the requested words. */
    onConfirmed: () => Promise<void>
    /** Present only where leaving it for later is allowed. */
    onLater?: () => void
}) {
    const { t } = useTranslation()
    const theme = useTheme()
    // A raw-key root has no phrase, and none is ever derived for it (ADR 0024 D5).
    const words = useMemo(() => (identity.mnemonic ? identity.mnemonic.split(" ") : []), [identity.mnemonic])
    const positions = useMemo(() => pickConfirmationPositions(words.length), [words.length])
    const [step, setStep] = useState<"show" | "check">("show")
    const [answers, setAnswers] = useState<Record<number, string>>({})
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const correct = positions.every((position) => (answers[position] ?? "").trim().toLowerCase() === words[position])

    if (step === "show") {
        return (
            <IdentityStep
                title={t("identity.phrase.title")}
                description={t("identity.phrase.desc", { count: words.length })}
                actions={
                    <>
                        <Button appearance="solid" tone="action" size="lg" fullWidth onPress={() => setStep("check")}>
                            {t("identity.phrase.wroteDown")}
                        </Button>
                        {onLater ? (
                            <Button appearance="plain" tone="neutral" size="lg" fullWidth onPress={onLater}>
                                {t("identity.common.later")}
                            </Button>
                        ) : null}
                    </>
                }
            >
                <ol className="grid grid-cols-3 gap-2" data-testid="recovery-phrase">
                    {words.map((word, index) => (
                        <li
                            key={`${index}-${word}`}
                            className="rounded-xl border px-2 py-2 font-mono text-sm"
                            style={{ borderColor: theme.colors.border, color: theme.colors.text }}
                        >
                            <span style={{ color: theme.colors.textSecondary }}>{index + 1}. </span>
                            {word}
                        </li>
                    ))}
                </ol>
            </IdentityStep>
        )
    }

    return (
        <IdentityStep
            title={t("identity.phrase.checkTitle")}
            description={t("identity.phrase.checkDesc")}
            actions={
                <>
                    <Button
                        appearance="solid"
                        tone="action"
                        size="lg"
                        fullWidth
                        disabled={!correct || busy}
                        loading={busy}
                        onPress={() => {
                            setBusy(true)
                            setError(null)
                            onConfirmed().catch((reason: unknown) => {
                                setError(reason instanceof Error ? reason.message : t("identity.errors.saveFailed"))
                                setBusy(false)
                            })
                        }}
                    >
                        {t("identity.phrase.confirm")}
                    </Button>
                    <Button appearance="plain" tone="neutral" size="lg" fullWidth onPress={() => setStep("show")}>
                        {t("identity.phrase.showAgain")}
                    </Button>
                </>
            }
        >
            {positions.map((position) => (
                <div key={position} className="flex flex-col gap-1.5">
                    <TextFieldLabel>{t("identity.phrase.word", { n: position + 1 })}</TextFieldLabel>
                    <TextField radius={999}>
                        <TextFieldInput
                            label={t("identity.phrase.word", { n: position + 1 })}
                            value={answers[position] ?? ""}
                            onValueChange={(next) => setAnswers((current) => ({ ...current, [position]: next }))}
                            autoCapitalize="none"
                            autoComplete="off"
                            autoCorrect={false}
                            spellCheck={false}
                        />
                    </TextField>
                </div>
            ))}
            <IdentityError message={error} />
        </IdentityStep>
    )
}
