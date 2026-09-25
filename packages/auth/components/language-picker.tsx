import { useId } from "react"
import { useTranslation } from "@/lib/i18n/use-translation"
import { LOCALE_LABELS, SUPPORTED_LOCALES, type Locale } from "@/lib/i18n/types"

/**
 * Compact language picker used in the auth app footer.
 *
 * Uses a native `<select>` so we inherit OS-native dropdown styling on
 * mobile, full keyboard a11y, and screen reader semantics for free
 * without dragging in extra dependencies.
 */
export function LanguagePicker({ className }: { className?: string }) {
    const { t, locale, setLocale } = useTranslation()
    const id = useId()

    return (
        <div className={["inline-flex items-center gap-2 text-sm", className].filter(Boolean).join(" ")}>
            <label htmlFor={id} className="text-muted-foreground">
                {t("language.picker.label")}
            </label>
            <select
                id={id}
                value={locale}
                aria-label={t("language.picker.ariaLabel")}
                onChange={(event) => setLocale(event.target.value as Locale)}
                className="rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 cursor-pointer"
            >
                {SUPPORTED_LOCALES.map((value) => (
                    <option key={value} value={value}>
                        {LOCALE_LABELS[value]}
                    </option>
                ))}
            </select>
        </div>
    )
}
