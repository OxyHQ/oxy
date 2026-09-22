import React, { memo } from 'react';
import { View } from 'react-native';
import { GroupedItem } from './grouped-item';
import type { IconName } from '@/constants/icons';

interface GroupedSectionItem {
    id: string;
    icon?: string;
    iconColor?: string;
    title: string;
    subtitle?: string;
    onPress?: () => void;
    showChevron?: boolean;
    disabled?: boolean;
    customContent?: React.ReactNode;
    customIcon?: React.ReactNode;
}

interface GroupedSectionProps {
    items: GroupedSectionItem[];
}

const GroupedSectionComponent = ({ items }: GroupedSectionProps) => {
    return (
        <View style={{ width: '100%' }}>
            {items.map((item, index) => (
                <View key={`${item.id}-${index}`} style={{ marginBottom: index < items.length - 1 ? 4 : 0 }}>
                    <GroupedItem
                        icon={item.icon as IconName | undefined}
                        iconColor={item.iconColor}
                        title={item.title}
                        subtitle={item.subtitle}
                        onPress={item.onPress}
                        isFirst={index === 0}
                        isLast={index === items.length - 1}
                        showChevron={item.showChevron}
                        disabled={item.disabled}
                        customContent={item.customContent}
                        customIcon={item.customIcon}
                    />
                </View>
            ))}
        </View>
    );
};

GroupedSectionComponent.displayName = 'GroupedSection';

export const GroupedSection = memo(GroupedSectionComponent);

