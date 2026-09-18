import type React from 'react';
import { View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { Card } from '@oxy.so/bloom/card';
import { RADIUS, SPACING, TYPOGRAPHY } from '@oxy.so/bloom/design-tokens';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';

/**
 * BenefitList / BenefitRow — a bordered card stacking "icon + caption" rows,
 * used by the verification, trust and premium screens.
 *
 * Bloom 2.0 removed its `benefit-list` family with no replacement, so the SDK
 * keeps this small local copy built from Bloom primitives (`Card`, `Text`,
 * design tokens) with the same props its call sites already use.
 */

/** Side of the rounded icon square. */
const ICON_SQUARE_SIZE = 36;

export interface BenefitRowProps {
    /** Leading icon element, rendered inside a rounded tertiary-fill square. */
    icon: React.ReactNode;
    /** Caption text. Provide either `label` or `children`. */
    label?: string;
    /** Caption content as children (alternative to `label`). */
    children?: React.ReactNode;
    /** Accessibility label for the row (defaults to string content). */
    accessibilityLabel?: string;
    className?: string;
    style?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
}

export const BenefitRow: React.FC<BenefitRowProps> = ({
    icon,
    label,
    children,
    accessibilityLabel,
    className,
    style,
    textStyle,
}) => {
    const { colors } = useTheme();
    const content = children ?? label;
    const a11y = accessibilityLabel ?? (typeof content === 'string' ? content : undefined);

    return (
        <View
            className={className}
            style={[{ flexDirection: 'row', alignItems: 'center', gap: SPACING['space-12'] }, style]}
            accessibilityLabel={a11y}
            {...(a11y ? { accessibilityRole: 'text' as const } : {})}
        >
            <View
                style={{
                    width: ICON_SQUARE_SIZE,
                    height: ICON_SQUARE_SIZE,
                    borderRadius: RADIUS['radius-12'],
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: colors.backgroundTertiary,
                }}
                accessibilityElementsHidden
                aria-hidden
            >
                {icon}
            </View>
            <Text
                style={[
                    {
                        flex: 1,
                        fontSize: TYPOGRAPHY.caption.size,
                        lineHeight: TYPOGRAPHY.caption.lineHeight,
                        fontWeight: TYPOGRAPHY.caption.weight,
                        color: colors.textSecondary,
                    },
                    textStyle,
                ]}
            >
                {content}
            </Text>
        </View>
    );
};

export interface BenefitListProps {
    /** `BenefitRow`s (or any nodes) stacked with consistent spacing. */
    children: React.ReactNode;
    accessibilityLabel?: string;
    className?: string;
    style?: StyleProp<ViewStyle>;
}

export const BenefitList: React.FC<BenefitListProps> = ({
    children,
    accessibilityLabel,
    className,
    style,
}) => (
    <Card
        variant="outlined"
        radius="radius-20"
        border="hairline"
        elevation="s"
        className={className}
        style={[{ padding: SPACING['space-16'], gap: SPACING['space-16'], overflow: 'visible' }, style]}
        accessibilityLabel={accessibilityLabel}
    >
        {children}
    </Card>
);
