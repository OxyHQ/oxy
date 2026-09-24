import type React from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { Text } from '@oxy.so/bloom/typography';
import { Image as ExpoImage } from 'expo-image';
import Ionicons from '../../icons/Ionicons';
import { Dialog, type DialogControlProps } from '@oxy.so/bloom/dialog';
import { useTheme } from '@oxy.so/bloom/theme';
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
                <Button appearance="plain" tone="neutral" iconOnly accessibilityLabel="Close upload preview" onPress={onCancel}
                    icon={<Ionicons name="close" size={24} color={colors.text} />} />
            </View>

            <ScrollView className="flex-1 p-[16px]">
                {pendingFiles.map((pendingFile) => {
                    const isImage = pendingFile.type.startsWith('image/');
                    return (
                        <Card key={pendingFile.id} appearance="subtle" className="flex-row items-center p-3 mb-3 gap-3">
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
                            <Button appearance="plain" tone="danger" iconOnly accessibilityLabel={`Remove ${pendingFile.name}`}
                                onPress={() => onRemoveFile(pendingFile.id)}
                                icon={<Ionicons name="close-circle" size={24} color={colors.error} />} />
                        </Card>
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
                        <Button appearance="subtle" tone="neutral" style={{ flex: 1 }} onPress={onCancel}>Cancel</Button>
                        <Button style={{ flex: 2 }} onPress={onConfirm}>Upload</Button>
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
