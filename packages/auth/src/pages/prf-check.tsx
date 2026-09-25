import { useState } from "react"
import { Button } from "@oxy.so/bloom/button"
import { useTheme } from "@oxy.so/bloom/theme"
import { Text } from "@oxy.so/bloom/typography"
import { WEB_IDENTITY_PRF_INPUT } from "@oxy.so/core"
import { base64UrlToBuffer } from "@/lib/identity/base64url"
import { readPrfOutput } from "@/lib/identity/passkey"
import { messageOf } from "@/lib/identity/ports"
import { useTranslation } from "@/lib/i18n/use-translation"
import { IdentityError, IdentityStep } from "@/components/identity/parts"

/** The passkey RP every Oxy credential is scoped to (ADR 0024 D2: always explicit). */
const RP_ID = "oxy.so"

interface Probe {
    firstPresent: boolean
    secondPresent: boolean
    stable: boolean
}

/**
 * `/prf-check` — does THIS browser + passkey provide a stable PRF output?
 *
 * Two local ceremonies with the same passkey, comparing the outputs. Nothing is
 * sent to any server and nothing is stored; the outputs themselves are never
 * displayed, only whether they exist and match.
 */
export function PrfCheckPage() {
    const { t } = useTranslation()
    const theme = useTheme()
    const [probe, setProbe] = useState<Probe | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    async function ceremony(credentialId?: string) {
        const challenge = new Uint8Array(32)
        crypto.getRandomValues(challenge)
        const credential = (await navigator.credentials.get({
            publicKey: {
                challenge,
                rpId: RP_ID,
                userVerification: "required",
                allowCredentials: credentialId ? [{ id: base64UrlToBuffer(credentialId), type: "public-key" }] : undefined,
                extensions: { prf: { eval: { first: WEB_IDENTITY_PRF_INPUT } } } as AuthenticationExtensionsClientInputs,
            },
        })) as PublicKeyCredential | null
        if (!credential) throw new Error(t("identity.errors.cancelled"))
        return { credentialId: credential.id, output: readPrfOutput(credential.getClientExtensionResults()) }
    }

    async function run() {
        setBusy(true)
        setError(null)
        setProbe(null)
        try {
            const first = await ceremony()
            const second = await ceremony(first.credentialId)
            const stable = !!first.output && !!second.output && first.output.every((byte, index) => byte === second.output?.[index])
            setProbe({ firstPresent: !!first.output, secondPresent: !!second.output, stable })
            first.output?.fill(0)
            second.output?.fill(0)
        } catch (reason) {
            setError(messageOf(reason, t))
        } finally {
            setBusy(false)
        }
    }

    const row = (label: string, value: string) => (
        <div className="flex justify-between gap-4">
            <Text style={{ color: theme.colors.textSecondary }}>{label}</Text>
            <Text style={{ color: theme.colors.text }}>{value}</Text>
        </div>
    )

    return (
        <IdentityStep
            title={t("identity.prf.title")}
            description={t("identity.prf.desc")}
            actions={
                <Button appearance="solid" tone="action" size="lg" fullWidth loading={busy} disabled={busy} onPress={() => void run()}>
                    {busy ? t("identity.prf.checking") : t("identity.prf.run")}
                </Button>
            }
        >
            <IdentityError message={error} />
            {probe ? (
                <div className="flex flex-col gap-2">
                    {row(t("identity.prf.first"), probe.firstPresent ? t("identity.prf.yes") : t("identity.prf.no"))}
                    {row(t("identity.prf.second"), probe.secondPresent ? t("identity.prf.yes") : t("identity.prf.no"))}
                    {row(t("identity.prf.same"), probe.stable ? t("identity.prf.stable") : t("identity.prf.unstable"))}
                </div>
            ) : null}
        </IdentityStep>
    )
}
