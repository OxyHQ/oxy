import React from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { ThemedText } from '../themed-text';
import { useColors } from '@/hooks/useColors';

interface ImportantBannerProps {
    children: React.ReactNode;
    title?: string;
    style?: StyleProp<ViewStyle>;
    icon?: keyof typeof MaterialCommunityIcons.glyphMap;
    iconSize?: number;
}

/**
 * Reusable Important Banner Component
 * Displays a warning/important message with an icon and title
 */
export function ImportantBanner({
    children,
    title = 'Important',
    style,
    icon = 'alert-circle',
    iconSize = 24,
}: ImportantBannerProps) {
    const colors = useColors();

    return (
        <View
            style={[
                styles.banner,
                {
                    backgroundColor: colors.bannerWarningBackground,
                    borderColor: colors.bannerWarningBorder,
                },
                style,
            ]}
        >
            <View style={styles.header}>
                <MaterialCommunityIcons
                    name={icon}
                    size={iconSize}
                    color={colors.bannerWarningIcon}
                />
                <ThemedText
                    style={[styles.title, { color: colors.bannerWarningText }]}
                >
                    {title}
                </ThemedText>
            </View>
            <ThemedText style={[styles.text, { color: colors.bannerWarningText }]}>
                {children}
            </ThemedText>
        </View>
    );
}

const styles = StyleSheet.create({
    banner: {
        borderWidth: 1,
        borderRadius: 16,
        padding: 16,
        marginBottom: 16,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    title: {
        fontSize: 16,
        fontWeight: '600',
        marginLeft: 8,
    },
    text: {
        fontSize: 14,
        lineHeight: 20,
    },
});

