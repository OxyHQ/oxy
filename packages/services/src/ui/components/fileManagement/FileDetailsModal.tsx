import type React from 'react';
import { View, Text } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Button } from '@oxyhq/bloom/button';
import { useTheme } from '@oxyhq/bloom/theme';
import { surfaces, type SurfaceControls } from '@oxyhq/bloom/surfaces';
import type { FileMetadata } from '@oxyhq/core';
import { useI18n } from '../../hooks/useI18n';
import { formatFileSize, getFileIcon } from '../../utils/fileManagement';

interface FileDetailsModalProps {
    /** The presenting surface's controls (from `surfaces.present`). */
    surface: SurfaceControls;
    file: FileMetadata;
    onDownload: (fileId: string, filename: string) => void;
    onDelete: (fileId: string, filename: string) => void;
    isOwner: boolean;
}

/**
 * File-detail panel — a rich presented surface (NOT a yes/no confirm): a file's
 * icon + metadata plus download / delete / cancel actions. Each action first
 * dismisses this surface, then runs its handler, so a follow-up delete confirm
 * stacks cleanly above whatever remains. Presented via {@link presentFileDetails}.
 */
export const FileDetailsModal: React.FC<FileDetailsModalProps> = ({
    surface,
    file,
    onDownload,
    onDelete,
    isOwner,
}) => {
    const { t } = useI18n();
    const { colors } = useTheme();

    return (
        <View>
            <View className="bg-secondary border-border p-[18px] rounded-[14px] border items-center">
                <View className="mb-space-16">
                    <Ionicons
                        name={getFileIcon(file.contentType)}
                        size={64}
                        color={colors.primary}
                    />
                </View>

                <Text className="text-text text-[20px] font-bold text-center mb-space-24">
                    {file.filename}
                </Text>

                <View className="w-full mb-space-32">
                    <View className="flex-row justify-between items-start mb-space-12 flex-wrap">
                        <Text className="text-text-secondary text-[16px] font-medium flex-1 min-w-[100px]">
                            {t('fileManagement.size')}:
                        </Text>
                        <Text className="text-text text-[16px] flex-[2] text-right">
                            {formatFileSize(file.length)}
                        </Text>
                    </View>

                    <View className="flex-row justify-between items-start mb-space-12 flex-wrap">
                        <Text className="text-text-secondary text-[16px] font-medium flex-1 min-w-[100px]">
                            {t('fileManagement.details.type')}:
                        </Text>
                        <Text className="text-text text-[16px] flex-[2] text-right">
                            {file.contentType}
                        </Text>
                    </View>

                    <View className="flex-row justify-between items-start mb-space-12 flex-wrap">
                        <Text className="text-text-secondary text-[16px] font-medium flex-1 min-w-[100px]">
                            {t('fileManagement.details.uploaded')}:
                        </Text>
                        <Text className="text-text text-[16px] flex-[2] text-right">
                            {new Date(file.uploadDate).toLocaleString()}
                        </Text>
                    </View>

                    {file.metadata?.description && (
                        <View className="flex-row justify-between items-start mb-space-12 flex-wrap">
                            <Text className="text-text-secondary text-[16px] font-medium flex-1 min-w-[100px]">
                                {t('fileManagement.details.description')}:
                            </Text>
                            <Text className="text-text text-[16px] flex-[2] text-right">
                                {file.metadata.description}
                            </Text>
                        </View>
                    )}
                </View>
            </View>

            <View style={{ gap: 8 }}>
                <Button
                    variant="primary"
                    onPress={() => {
                        surface.dismiss();
                        onDownload(file.id, file.filename);
                    }}
                >
                    {t('fileManagement.details.download')}
                </Button>
                {isOwner ? (
                    <Button
                        variant="destructive"
                        onPress={() => {
                            surface.dismiss();
                            onDelete(file.id, file.filename);
                        }}
                    >
                        {t('common.actions.delete')}
                    </Button>
                ) : null}
                <Button variant="secondary" onPress={() => surface.dismiss()}>
                    {t('common.cancel')}
                </Button>
            </View>
        </View>
    );
};

/** Options accepted by {@link presentFileDetails} (everything but `surface`). */
type PresentFileDetailsOptions = Omit<FileDetailsModalProps, 'surface'>;

/** Present the file-detail panel on the shared surface stack. */
export function presentFileDetails(options: PresentFileDetailsOptions): void {
    void surfaces.present((surface) => (
        <FileDetailsModal surface={surface} {...options} />
    ));
}
