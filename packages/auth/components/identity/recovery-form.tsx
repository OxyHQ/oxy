import { useState } from "react"
import { Button } from "@oxy.so/bloom/button"
import { TextField, TextFieldHint, TextFieldInput } from "@oxy.so/bloom/text-field"
import { parseRecoveryMaterial, type WebIdentityRecoveryMaterial } from "@oxy.so/core"
import { useTranslation } from "@/lib/i18n/use-translation"
import { IdentityError, IdentityStep } from "./parts"

/**
 * Where a person types their recovery material: a 12- or 24-word phrase, or the
 * private key an older identity was imported with. Parsed here, on this page;
 * nothing typed is sent anywhere. The field is cleared as soon as it is read.
 */
export function RecoveryForm({
    title,
    description,
    submitLabel,
    error,
    onSubmit,
    onBack,
}: {
    title: string
    description: string
    submitLabel: string
    error: string | null
    onSubmit: (material: WebIdentityRecoveryMaterial) => void
    onBack: () => void
}) {
    const { t } = useTranslation()
    const [value, setValue] = useState("")
    const [invalid, setInvalid] = useState(false)

    const submit = () => {
        let material: WebIdentityRecoveryMaterial
        try {
            material = parseRecoveryMaterial(value)
        } catch {
            setInvalid(true)
            return
        }
        setValue("")
        onSubmit(material)
    }

    return (
        <IdentityStep
            title={title}
            description={description}
            actions={
                <>
                    <Button appearance="solid" tone="action" size="lg" fullWidth disabled={value.trim().length === 0} onPress={submit}>
                        {submitLabel}
                    </Button>
                    <Button appearance="plain" tone="neutral" size="lg" fullWidth onPress={onBack}>
                        {t("identity.common.back")}
                    </Button>
                </>
            }
        >
            <TextField invalid={invalid}>
                <TextFieldInput
                    label={t("identity.recover.field")}
                    value={value}
                    onValueChange={(next) => {
                        setValue(next)
                        setInvalid(false)
                    }}
                    multiline
                    numberOfLines={4}
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect={false}
                    spellCheck={false}
                    testID="recovery-material"
                />
            </TextField>
            {invalid ? <TextFieldHint invalid>{t("identity.recover.invalid")}</TextFieldHint> : null}
            <IdentityError message={error} />
        </IdentityStep>
    )
}
