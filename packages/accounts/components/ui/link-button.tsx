import React from 'react';
import { Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useHapticPress } from '@/hooks/use-haptic-press';
import type { MaterialCommunityIconName } from '@/types/icons';

interface LinkButtonProps {
    text: string;
    onPress?: () => void;
    icon?: MaterialCommunityIconName;
    count?: string | number;
}

export function LinkButton({ text, onPress, icon, count }: LinkButtonProps) {
    const colors = useColors();

    const handlePressIn = useHapticPress();

    return (
        <TouchableOpacity
            style={styles.linkButton}
            onPressIn={handlePressIn}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={count !== undefined ? `${text} ${count}` : text}
        >
            {icon && <MaterialCommunityIcons name={icon} size={16} color={colors.tint} />}
            <Text style={[styles.linkText, { color: colors.tint }]}>{text}</Text>
            {count !== undefined && (
                <Text style={[styles.linkCount, { color: colors.textSecondary }]}>{count}</Text>
            )}
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    linkButton: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 8,
        gap: 6,
    },
    linkText: {
        fontSize: 14,
        fontWeight: '500',
    },
    linkCount: {
        fontSize: 14,
        marginLeft: 4,
    },
});

