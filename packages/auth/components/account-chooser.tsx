import { ChevronRight, UserPlus } from "lucide-react"
import { showsPrincipalHeaders, type SwitcherContextRow, type SwitcherPrincipalRow } from "@oxyhq/core"
import { cn } from "@/lib/utils"
import { Button } from "@oxyhq/bloom/button"
import { Avatar } from "@oxyhq/bloom/avatar"
import { AuthFormHeader } from "@/components/auth-form-layout"

type AccountChooserProps = React.ComponentProps<"div"> & {
    /**
     * Everyone signed in on this device, each with the accounts they may act as.
     *
     * The device DIRECTORY (ADR 0002), through the SAME projection the SDK's own
     * switcher renders (`useDeviceSwitcher` → `buildSwitcherRows`). It is grouped
     * by person rather than flat because the same organization reachable through
     * two people is two rows under two humans, and a list keyed by account id has
     * one slot for it.
     */
    principals: SwitcherPrincipalRow[]
    /** App name to continue to, e.g. "Console". Falls back to a generic label. */
    appName?: string | null
    /**
     * Selecting a row. The IdP activates `context.contextId` — the PAIR, never an
     * account id, which cannot say which person's route was chosen.
     */
    onSelectContext: (context: SwitcherContextRow) => void
    /** "Use a different account" → reveals the sign-in form. */
    onUseAnother: () => void
    /** The `contextId` currently being activated (drives that row's busy state). */
    pendingContextId?: string | null
    /** Disables every row while a selection is in flight. */
    isLoading?: boolean
}

/**
 * Google-style account chooser. Lists every `principal acting as account` pair
 * on this device and a "Use a different account" affordance. Rendered as an
 * additive FRONT screen before the sign-in form / OAuth consent — selecting a row
 * activates that pair through the shared device-first path
 * (`useDeviceSwitcher().activateContext`) exactly like every other Oxy surface.
 */
export function AccountChooser({
    className,
    principals,
    appName,
    onSelectContext,
    onUseAnother,
    pendingContextId,
    isLoading,
    ...props
}: AccountChooserProps) {
    const description = appName
        ? `to continue to ${appName}`
        : "Choose an account to continue"

    // Naming the operator is only worth the line once somebody holds more than
    // one account here; two people with one account each is a plain list where
    // every row already IS a person. Same rule the SDK's switcher uses, so the
    // two surfaces agree on when the actor matters.
    const namesTheOperator = showsPrincipalHeaders(principals)

    return (
        <div className={cn("flex flex-col gap-6", className)} {...props}>
            <AuthFormHeader title="Choose an account" description={description} />
            <div className="space-y-2">
                {principals.flatMap((principal) =>
                    principal.contexts.map((context) => {
                        const isPending = pendingContextId === context.contextId
                        const secondary =
                            namesTheOperator && context.isDelegated
                                ? `Operated by ${principal.displayName}`
                                : context.handle
                                  ? `@${context.handle}`
                                  : null
                        return (
                            <div key={context.contextId}>
                                <Button
                                    variant="outline"
                                    size="lg"
                                    className="w-full h-auto p-4 justify-start"
                                    onClick={() => onSelectContext(context)}
                                    // A row the server marked unavailable is
                                    // rendered rather than hidden, so a revoked
                                    // membership is visible instead of a row that
                                    // silently stopped existing — and disabled,
                                    // because activating it is a request the
                                    // server refuses and then heals away.
                                    disabled={isLoading || !context.canActivate}
                                    aria-label={`Continue as ${context.displayName}`}
                                >
                                    <Avatar source={context.avatarUrl} size={40} />
                                    <div className="flex-1 text-left ml-3 min-w-0" aria-busy={isPending}>
                                        <div className="font-medium truncate">
                                            {context.displayName}
                                        </div>
                                        {secondary && (
                                            <div className="text-sm text-muted-foreground truncate">
                                                {context.canActivate ? secondary : "Unavailable right now"}
                                            </div>
                                        )}
                                    </div>
                                    <ChevronRight className="size-5 text-muted-foreground shrink-0" />
                                </Button>
                            </div>
                        )
                    }),
                )}

                <Button
                    variant="outline"
                    size="lg"
                    className="w-full h-auto p-4 justify-start"
                    onClick={onUseAnother}
                    disabled={isLoading}
                >
                    <div className="size-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                        <UserPlus className="size-5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 text-left ml-3">
                        <div className="font-medium">Use a different account</div>
                    </div>
                    <ChevronRight className="size-5 text-muted-foreground shrink-0" />
                </Button>
            </div>
        </div>
    )
}
