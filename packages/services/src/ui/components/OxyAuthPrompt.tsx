import type React from 'react';
import {
    StyleSheet,
    Text,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { useShallow } from 'zustand/react/shallow';
import { useAuthStore } from '../stores/authStore';
import LogoIcon from './logo/LogoIcon';
import OxySignInButton from './OxySignInButton';

export interface OxyAuthPromptProps {
    /**
     * Short label describing what the user is trying to access. Rendered as
     * the prompt title (e.g. "Notifications", "Privacy"). Keep it to 1-3
     * words; the subtitle expands on the rationale.
     */
    label: string;

    /**
     * Optional longer description. If omitted, a generic
     * `"Sign in to access your {label.toLowerCase()}."` is shown.
     */
    description?: string;

    /**
     * Variant of the embedded `OxySignInButton`. Defaults to `contained` for
     * primary placement; pass `outline` or `default` for secondary contexts.
     */
    signInButtonVariant?: 'default' | 'outline' | 'contained';

    /**
     * Container style override. Use sparingly - the prompt is designed to fit
     * inside a parent screen / sheet body with its own spacing.
     */
    style?: StyleProp<ViewStyle>;
}

/**
 * Inline empty-state shown when an unauthenticated user reaches a surface
 * that requires sign-in (e.g. a settings subscreen, a deep-linked private
 * route, the body of a tab that requires identity).
 *
 * Renders the Oxy logo, a section label, a rationale line, and an embedded
 * `OxySignInButton` that opens the standard sign-in flow (web modal /
 * native bottom sheet, identical to anywhere else `OxySignInButton` is
 * used).
 *
 * Mounts as a regular flex child - it does NOT cover the screen, take over
 * the navigation, or block the back button. For full-screen modal gating
 * use a Bloom Dialog/BottomSheet at the layout level and place this
 * component inside it.
 *
 * When the user is authenticated this component renders `null`. This makes
 * it safe to drop into a screen body without an `isAuthenticated` guard at
 * the call site.
 *
 * @example
 * ```tsx
 * if (!isAuthenticated) {
 *   return (
 *     <ThemedView className="flex-1">
 *       <Header options={{ title: 'Notifications' }} />
 *       <OxyAuthPrompt label="Notifications" />
 *     </ThemedView>
 *   );
 * }
 * ```
 */
export const OxyAuthPrompt: React.FC<OxyAuthPromptProps> = ({
    label,
    description,
    signInButtonVariant = 'contained',
    style,
}) => {
    const theme = useTheme();
    const isAuthenticated = useAuthStore(
        useShallow((state) => state.isAuthenticated)
    );

    if (isAuthenticated) return null;

    const resolvedDescription =
        description ?? `Sign in to access your ${label.toLowerCase()}.`;

    return (
        <View style={[styles.container, style]}>
            <View
                style={[
                    styles.logoBadge,
                    { backgroundColor: `${theme.colors.primary}15` },
                ]}
            >
                <LogoIcon height={44} color={theme.colors.primary} />
            </View>

            <View style={styles.copy}>
                <Text
                    accessibilityRole="header"
                    style={[styles.title, { color: theme.colors.text }]}
                >
                    {label}
                </Text>
                <Text
                    style={[
                        styles.subtitle,
                        { color: theme.colors.textSecondary },
                    ]}
                >
                    {resolvedDescription}
                </Text>
            </View>

            <OxySignInButton
                variant={signInButtonVariant}
                style={styles.cta}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: 32,
        paddingVertical: 48,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 20,
    },
    logoBadge: {
        width: 88,
        height: 88,
        borderRadius: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    copy: {
        alignItems: 'center',
        gap: 6,
    },
    title: {
        fontSize: 20,
        fontWeight: '700',
        textAlign: 'center',
    },
    subtitle: {
        fontSize: 14,
        lineHeight: 20,
        textAlign: 'center',
        maxWidth: 320,
    },
    cta: {
        marginTop: 4,
        width: '100%',
        maxWidth: 320,
    },
});

export default OxyAuthPrompt;
