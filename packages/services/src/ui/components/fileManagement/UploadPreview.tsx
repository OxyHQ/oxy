import type React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Ionicons from '../../icons/Ionicons';
import { Dialog, type DialogControlProps } from '@oxyhq/bloom/dialog';
import { useTheme } from '@oxyhq/bloom/theme';
import { formatFileSize, getFileIcon } from '../../utils/fileManagement';
import type { PendingUploadFile } from '../../screens/fileManagement/shared';

interface UploadPreviewProps {
    control?: DialogControlProps;
    pendingFiles: PendingUploadFile[];
    onConfirm: () => void;
    onCancel: () => void;
    onRemoveFile: (id: string) => void;
    inline?: boolean;
}

// `expo-image` takes no className remap — the thumbnail size stays inline.
const previewStyles = StyleSheet.create({
    thumbnail: {
        width: 60,
        height: 60,
        borderRadius: 8,
    },
});

const UploadPreviewContent: React.FC<{
    pendingFiles: PendingUploadFile[];
    onConfirm: () => void;
    onCancel: () => void;
    onRemoveFile: (id: string) => void;
    showActions?: boolean;
}> = ({
    pendingFiles,
    onConfirm,
    onCancel,
    onRemoveFile,
    showActions = true,
}) => {
    const { colors } = useTheme();
    const totalSize = pendingFiles.reduce((sum, f) => sum + f.size, 0);

    return (
        <View className="bg-bg flex-1">
            <View className="border-b border-border flex-row items-center justify-between px-[16px] py-[16px]">
                <Text className="text-text text-[20px] font-bold">
                    Review Files ({pendingFiles.length})
                </Text>
                <TouchableOpacity onPress={onCancel}>
                    <Ionicons name="close" size={24} color={colors.text} />
                </TouchableOpacity>
            </View>

            <ScrollView className="flex-1 p-[16px]">
                {pendingFiles.map((pendingFile) => {
                    const isImage = pendingFile.type.startsWith('image/');
                    return (
                        <View
                            key={pendingFile.id}
                            className="bg-secondary border-border flex-row items-center p-[12px] rounded-[12px] border mb-[12px] gap-[12px]"
                        >
                            {isImage && pendingFile.preview ? (
                                <ExpoImage
                                    source={{ uri: pendingFile.preview }}
                                    style={previewStyles.thumbnail}
                                    contentFit="cover"
                                />
                            ) : (
                                <View
                                    className="w-[60px] h-[60px] rounded-[8px] items-center justify-center"
                                    style={{ backgroundColor: colors.backgroundSecondary }}
                                >
                                    <Ionicons
                                        name={getFileIcon(pendingFile.type)}
                                        size={32}
                                        color={colors.primary}
                                    />
                                </View>
                            )}
                            <View className="flex-1 min-w-0">
                                <Text className="text-text text-[16px] font-semibold mb-[4px]" numberOfLines={1}>
                                    {pendingFile.name}
                                </Text>
                                <Text className="text-text-secondary text-[13px]">
                                    {formatFileSize(pendingFile.size)} • {pendingFile.type}
                                </Text>
                            </View>
                            <TouchableOpacity
                                className="p-[4px]"
                                onPress={() => onRemoveFile(pendingFile.id)}
                            >
                                <Ionicons name="close-circle" size={24} color={colors.error} />
                            </TouchableOpacity>
                        </View>
                    );
                })}
            </ScrollView>

            <View className="border-t border-border p-[16px]">
                <View className="flex-row justify-between mb-[16px]">
                    <Text className="text-text text-[15px] font-semibold">
                        {pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''}
                    </Text>
                    <Text className="text-text text-[15px] font-semibold">
                        {formatFileSize(totalSize)}
                    </Text>
                </View>
                {showActions && (
                    <View className="flex-row gap-[12px]">
                        <TouchableOpacity
                            className="bg-transparent border-border flex-1 py-[14px] rounded-[12px] border items-center justify-center"
                            onPress={onCancel}
                        >
                            <Text className="text-text text-[16px] font-semibold">
                                Cancel
                            </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            className="bg-primary flex-[2] flex-row items-center justify-center py-[14px] rounded-[12px] gap-[8px]"
                            onPress={onConfirm}
                        >
                            <Ionicons name="cloud-upload" size={20} color={colors.primaryForeground} />
                            <Text className="text-[16px] font-semibold" style={{ color: colors.primaryForeground }}>Upload</Text>
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        </View>
    );
};

export const UploadPreview: React.FC<UploadPreviewProps> = ({
    control,
    pendingFiles,
    onConfirm,
    onCancel,
    onRemoveFile,
    inline = false,
}) => {
    // Inline mode: render content directly without Dialog
    if (inline) {
        return (
            <UploadPreviewContent
                pendingFiles={pendingFiles}
                onConfirm={onConfirm}
                onCancel={onCancel}
                onRemoveFile={onRemoveFile}
            />
        );
    }

    // Dialog mode: requires control prop
    if (!control) return null;

    return (
        <Dialog
            control={control}
            onClose={onCancel}
            label="Review Files"
            actions={[
                { label: 'Upload', onPress: onConfirm },
                { label: 'Cancel', color: 'cancel' },
            ]}
        >
            <UploadPreviewContent
                pendingFiles={pendingFiles}
                onConfirm={onConfirm}
                onCancel={onCancel}
                onRemoveFile={onRemoveFile}
                showActions={false}
            />
        </Dialog>
    );
};
