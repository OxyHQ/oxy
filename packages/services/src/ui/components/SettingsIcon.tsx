import type React from 'react';
import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { darkenColor } from '../utils/colorUtils';

interface SettingsIconProps {
    /** MaterialCommunityIcons icon name */
    name: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
    /** Background color for the circle */
    color: string;
    /** Icon size (default 14, fits bloom's 20x20 container) */
    iconSize?: number;
    /** Container size (default 20, matches bloom SettingsListItem icon slot) */
    size?: number;
}

/**
 * Compact colored-circle icon for use with bloom's SettingsListItem.
 * Renders a MaterialCommunityIcons glyph inside a tinted circle,
 * sized to fit bloom's 20x20 icon container.
 */
const SettingsIconComponent: React.FC<SettingsIconProps> = ({
    name,
    color,
    iconSize = 14,
    size = 20,
}) => (
    <View style={[styles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }]}>
        <MaterialCommunityIcons name={name} size={iconSize} color={darkenColor(color)} />
    </View>
);

SettingsIconComponent.displayName = 'SettingsIcon';

export const SettingsIcon = memo(SettingsIconComponent);
export default SettingsIcon;

const styles = StyleSheet.create({
    circle: {
        alignItems: 'center',
        justifyContent: 'center',
    },
});
