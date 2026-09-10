import type React from 'react';
import { Text, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { useTheme } from '@oxy.so/bloom/theme';
import { surfaces, type SurfaceControls } from '@oxy.so/bloom/surfaces';

/**
 * A single choice in an {@link ActionSheetSurface} — a labelled button that
 * resolves the surface with `value` when pressed.
 */
export interface ActionSheetOption<T extends string> {
    label: string;
    value: T;
    /** Render as a destructive (negative) button. */
    destructive?: boolean;
}

export interface ActionSheetSurfaceProps<T extends string> {
    /** The presenting surface's controls (from `surfaces.present`). */
    surface: SurfaceControls;
    /** Headline. */
    title: string;
    /** Optional supporting copy. */
    message?: string;
    /** The choices; each dismisses the surface with its `value`. */
    options: ActionSheetOption<T>[];
    /** Cancel button label — dismisses with `undefined`. */
    cancelLabel: string;
}

const TITLE_STYLE = { fontSize: 22, fontWeight: '600' as const, lineHeight: 30 };
const MESSAGE_STYLE = { fontSize: 16, lineHeight: 22 };

/**
 * A multi-choice action sheet rendered as a shared-stack surface — the
 * many-option counterpart to Bloom's two-way `surfaces.confirm`. Each option
 * button resolves the surface's `present()` promise with that option's `value`;
 * cancel / backdrop / Escape resolve `undefined`. Presented via
 * {@link presentActionSheet}.
 */
export function ActionSheetSurface<T extends string>({
    surface,
    title,
    message,
    options,
    cancelLabel,
}: ActionSheetSurfaceProps<T>): React.ReactElement {
    const theme = useTheme();

    return (
        <View>
            <Text
                style={[
                    TITLE_STYLE,
                    { color: theme.colors.text, paddingBottom: message ? 4 : 16 },
                ]}
            >
                {title}
            </Text>
            {message ? (
                <Text
                    style={[
                        MESSAGE_STYLE,
                        { color: theme.colors.textSecondary, paddingBottom: 16 },
                    ]}
                >
                    {message}
                </Text>
            ) : null}
            <View style={{ gap: 8 }}>
                {options.map((option) => (
                    <Button
                        key={option.value}
                        variant={option.destructive ? 'destructive' : 'primary'}
                        onPress={() => surface.dismiss(option.value)}
                    >
                        {option.label}
                    </Button>
                ))}
                <Button variant="secondary" onPress={() => surface.dismiss(undefined)}>
                    {cancelLabel}
                </Button>
            </View>
        </View>
    );
}

/**
 * Present an {@link ActionSheetSurface} on the shared stack and resolve with the
 * chosen option `value`, or `undefined` if cancelled/dismissed.
 */
export function presentActionSheet<T extends string>(
    options: Omit<ActionSheetSurfaceProps<T>, 'surface'>,
): Promise<T | undefined> {
    return surfaces.present<T | undefined>((surface) => (
        <ActionSheetSurface surface={surface} {...options} />
    ));
}
