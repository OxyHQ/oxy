import type { ReactNode } from "react"
import { useTheme } from "@oxy.so/bloom/theme"
import { Text } from "@oxy.so/bloom/typography"
import { OxyAuthLoading, OxyAuthScreen, OxyAuthScreenHeader } from "@oxy.so/services"

/**
 * The web identity carrier's screens, built from the SDK's sign-in shell so they
 * read as the same product as `/login`. Holder-only by design: these run on
 * auth.oxy.so, the one origin the API serves the identity routes to, and never
 * ship in `@oxy.so/services`, which every app bundles.
 */

/** One step of an identity flow: the header, its body, then its actions stacked. */
export function IdentityStep({
    title,
    description,
    children,
    actions,
}: {
    title: string
    description?: ReactNode
    children?: ReactNode
    actions?: ReactNode
}) {
    return (
        <OxyAuthScreen>
            <OxyAuthScreenHeader title={title} description={description} />
            {children}
            {actions ? <div className="flex flex-col gap-3">{actions}</div> : null}
        </OxyAuthScreen>
    )
}

/** A step in flight: the spinner, and what it is waiting for. */
export function IdentityWorking({ label }: { label: string }) {
    const theme = useTheme()
    return (
        <OxyAuthScreen>
            <OxyAuthLoading />
            <Text style={{ textAlign: "center", color: theme.colors.textSecondary }}>{label}</Text>
        </OxyAuthScreen>
    )
}

/** Why the last step failed, shown where it happened. */
export function IdentityError({ message }: { message: string | null }) {
    const theme = useTheme()
    if (!message) return null
    return (
        <Text accessibilityRole="alert" style={{ color: theme.colors.error }}>
            {message}
        </Text>
    )
}

/** A line the person should not miss — an unsaved phrase, an unsecured account. */
export function IdentityNote({ children }: { children: ReactNode }) {
    const theme = useTheme()
    return <Text style={{ color: theme.colors.warning }}>{children}</Text>
}

/** Body copy. */
export function IdentityText({ children }: { children: ReactNode }) {
    const theme = useTheme()
    return <Text style={{ color: theme.colors.textSecondary, fontSize: 16, lineHeight: 24 }}>{children}</Text>
}
