import type React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import Ionicons from '../../icons/Ionicons';

export interface FileLibraryErrorProps {
    title: string;
    description: string;
    retryLabel: string;
    onRetry: () => void;
    /** Failure icon tint. */
    iconColor: string;
    titleColor: string;
    descriptionColor: string;
    /** Retry button background (button label/icon are always white). */
    buttonColor: string;
}

/**
 * Terminal load-failure surface for the file library — rendered (INSTEAD of the
 * "no files yet" empty state) when the list query errors with nothing cached, so
 * a failed load never masquerades as an empty library. Pure presentational; the
 * Retry action is wired to the query's `refetch()` by the caller. Themed via
 * color props so it fits both the browse chrome and the dark picker backdrop.
 */
const FileLibraryError: React.FC<FileLibraryErrorProps> = ({
    title,
    description,
    retryLabel,
    onRetry,
    iconColor,
    titleColor,
    descriptionColor,
    buttonColor,
}) => (
    <View className="items-center py-[40px] px-[24px]">
        <Ionicons name="cloud-offline-outline" size={64} color={iconColor} />
        <Text className="text-[24px] font-bold mt-[16px] mb-[8px] text-center" style={{ color: titleColor }}>
            {title}
        </Text>
        <Text className="text-[16px] text-center leading-[24px] mb-[32px]" style={{ color: descriptionColor }}>
            {description}
        </Text>
        <TouchableOpacity
            className="flex-row items-center px-[24px] py-[12px] rounded-[24px] gap-[8px]"
            style={{ backgroundColor: buttonColor }}
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel={retryLabel}
        >
            <Ionicons name="refresh" size={20} color="#FFFFFF" />
            <Text className="text-white text-[16px] font-semibold">{retryLabel}</Text>
        </TouchableOpacity>
    </View>
);

export default FileLibraryError;
