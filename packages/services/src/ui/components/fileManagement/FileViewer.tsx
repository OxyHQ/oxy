import type React from 'react';
import { useMemo, useState, useEffect } from 'react';
import { View, ScrollView, ActivityIndicator, Image, StyleSheet } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { Image as ExpoImage } from 'expo-image';
import MaterialCommunityIcons from '../../icons/MaterialCommunityIcons';
import { useTheme } from '@oxy.so/bloom/theme';
import type { FileMetadata } from '@oxy.so/core';
import { formatFileSize } from '../../utils/fileManagement';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';

interface FileViewerProps {
    file: FileMetadata;
    fileContent: string | null;
    loadingFileContent: boolean;
    showFileDetailsInViewer: boolean;
    onToggleDetails: () => void;
    onClose: () => void;
    onDownload: (fileId: string, filename: string) => void;
    onDelete: (fileId: string, filename: string) => void;
    isOwner: boolean;
}

// Genuinely-inline-only styles: the full-bleed blurred background is an
// `expo-image` (no className remap), and `imageContainer` is a measurement
// wrapper whose `onLayout` never fires on web for a className'd component.
const viewerStyles = StyleSheet.create({
    backgroundImage: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
    },
    imageContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        marginTop: 56,
        marginBottom: 8,
        paddingHorizontal: 12,
    },
});

export const FileViewer: React.FC<FileViewerProps> = ({
    file,
    fileContent,
    loadingFileContent,
    showFileDetailsInViewer,
    onToggleDetails,
    onClose,
    onDownload,
    onDelete,
    isOwner,
}) => {
    const { colors } = useTheme();
    const isImage = file.contentType.startsWith('image/');
    const isText = file.contentType.startsWith('text/') ||
        file.contentType.includes('json') ||
        file.contentType.includes('xml') ||
        file.contentType.includes('javascript') ||
        file.contentType.includes('typescript');
    const isPDF = file.contentType.includes('pdf');
    const isVideo = file.contentType.startsWith('video/');
    const isAudio = file.contentType.startsWith('audio/');

    const [containerWidth, setContainerWidth] = useState<number>(0);
    const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);

    // Load image dimensions when image content is available
    useEffect(() => {
        if (isImage && fileContent) {
            Image.getSize(
                fileContent,
                (width, height) => {
                    setImageDimensions({ width, height });
                },
                () => {
                    // Fallback if dimensions can't be loaded
                    setImageDimensions({ width: 400, height: 400 });
                }
            );
        } else {
            setImageDimensions(null);
        }
    }, [isImage, fileContent]);

    // Calculate display size based on natural dimensions and max constraints
    // Use natural size when smaller, scale down when larger
    const imageDisplaySize = useMemo(() => {
        if (!imageDimensions || !containerWidth) {
            // Return default size while loading
            return { width: 400, height: 400 };
        }

        const maxWidth = containerWidth - 24; // Account for padding
        const maxHeight = 500;
        const aspectRatio = imageDimensions.width / imageDimensions.height;

        // Start with natural dimensions
        let displayWidth = imageDimensions.width;
        let displayHeight = imageDimensions.height;

        // Only scale down if exceeds max width
        if (displayWidth > maxWidth) {
            displayWidth = maxWidth;
            displayHeight = displayWidth / aspectRatio;
        }

        // Only scale down if exceeds max height
        if (displayHeight > maxHeight) {
            displayHeight = maxHeight;
            displayWidth = displayHeight * aspectRatio;
        }

        return { width: displayWidth, height: displayHeight };
    }, [imageDimensions, containerWidth]);

    const fileDetailItems = useMemo(() => {
        const items: Array<{ id: string; iconName: React.ComponentProps<typeof MaterialCommunityIcons>['name']; iconColor: string; title: string; description: string }> = [
            {
                id: 'filename',
                iconName: 'file-document',
                iconColor: colors.info,
                title: 'File Name',
                description: file.filename,
            },
            {
                id: 'size',
                iconName: 'server',
                iconColor: colors.warning,
                title: 'Size',
                description: formatFileSize(file.length),
            },
            {
                id: 'type',
                iconName: 'code-tags',
                iconColor: colors.primary,
                title: 'Type',
                description: file.contentType,
            },
            {
                id: 'uploaded',
                iconName: 'clock',
                iconColor: colors.success,
                title: 'Uploaded',
                description: new Date(file.uploadDate).toLocaleString(),
            },
        ];

        if (file.metadata?.description) {
            items.push({
                id: 'description',
                iconName: 'text',
                iconColor: colors.primary,
                title: 'Description',
                description: file.metadata.description,
            });
        }

        items.push({
            id: 'fileId',
            iconName: 'key',
            iconColor: colors.info,
            title: 'File ID',
            description: file.id,
        });

        return items;
    }, [file, colors]);

    return (
        <View
            className={`flex-1 relative ${isImage && fileContent ? '' : 'bg-bg'}`}
        >
            {/* Blurred Background Image - only for images */}
            {isImage && fileContent && (
                <>
                    <ExpoImage
                        source={{ uri: fileContent }}
                        style={viewerStyles.backgroundImage}
                        contentFit="cover"
                        blurRadius={50}
                        transition={120}
                        cachePolicy="memory-disk"
                    />
                    <View
                        className="absolute top-0 left-0 right-0 bottom-0"
                        style={{ backgroundColor: colors.overlay, zIndex: 1 }}
                    />
                </>
            )}

            {/* Floating Back Button */}
            <Button appearance="subtle" tone="neutral" iconOnly accessibilityLabel="Back"
                className="absolute top-[12px] left-[12px]"
                style={{ zIndex: 10 }}
                onPress={onClose}
            icon={<MaterialCommunityIcons name="arrow-left" size={20} color={colors.text} />} />

            {/* Floating Download Button */}
            <Button appearance="subtle" tone="neutral" iconOnly accessibilityLabel="Download"
                className="absolute top-[12px] right-[12px]"
                style={{ zIndex: 10 }}
                onPress={() => onDownload(file.id, file.filename)}
            icon={<MaterialCommunityIcons name="download" size={20} color={colors.primary} />} />

            {/* File Content */}
            <ScrollView
                className="flex-1 relative"
                style={{ zIndex: 2 }}
                contentContainerClassName="grow px-[12px] pt-0 pb-[8px]"
            >
                {loadingFileContent ? (
                    <View className="flex-1 justify-center items-center">
                        <ActivityIndicator size="large" color={colors.primary} />
                        <Text className="text-text text-[16px] mt-[16px]">
                            Loading file content...
                        </Text>
                    </View>
                ) : isImage && fileContent ? (
                    <View
                        style={viewerStyles.imageContainer}
                        onLayout={(e) => {
                            const width = e.nativeEvent.layout.width;
                            if (width > 0) {
                                setContainerWidth(width);
                            }
                        }}
                    >
                        <View
                            className="rounded-[24px] overflow-hidden self-center"
                            style={{
                                width: imageDisplaySize.width,
                                height: imageDisplaySize.height,
                            }}
                        >
                            <ExpoImage
                                source={{ uri: fileContent }}
                                style={{
                                    width: imageDisplaySize.width,
                                    height: imageDisplaySize.height,
                                }}
                                contentFit="contain"
                                transition={120}
                                cachePolicy="memory-disk"
                                onError={() => {
                                    // Image failed to load
                                }}
                                accessibilityLabel={file.filename}
                            />
                        </View>
                    </View>
                ) : isText && fileContent ? (
                    <View className="bg-card flex-1 rounded-[18px] p-[12px] min-h-[180px]" style={{ maxHeight: '80%' }}>
                        <ScrollView className="flex-1" nestedScrollEnabled>
                            <Text className="text-text text-[14px] leading-[20px]" style={{ fontFamily: 'monospace' }}>
                                {fileContent}
                            </Text>
                        </ScrollView>
                    </View>
                ) : isPDF && fileContent ? (
                    <View className="flex-1 justify-center items-center py-[32px] px-[24px]">
                        <MaterialCommunityIcons
                            name="file-pdf-box"
                            size={64}
                            color={colors.textSecondary}
                        />
                        <Text className="text-text text-[24px] font-bold mt-[16px] mb-[8px] text-center">
                            PDF Preview Not Available
                        </Text>
                        <Text className="text-text-secondary text-[16px] text-center leading-[24px] mb-[32px]">
                            PDF files cannot be previewed in this viewer.{'\n'}
                            Download the file to view its contents.
                        </Text>
                        <Button onPress={() => onDownload(file.id, file.filename)}>Download PDF</Button>
                    </View>
                ) : isVideo && fileContent ? (
                    <View className="flex-1 justify-center items-center py-[32px] px-[24px]">
                        <MaterialCommunityIcons
                            name="video-outline"
                            size={64}
                            color={colors.textSecondary}
                        />
                        <Text className="text-text text-[24px] font-bold mt-[16px] mb-[8px] text-center">
                            Video Playback Not Available
                        </Text>
                        <Text className="text-text-secondary text-[16px] text-center leading-[24px] mb-[32px]">
                            Video playback is not supported in this viewer.{'\n'}
                            Download the file to view it.
                        </Text>
                        <Button onPress={() => onDownload(file.id, file.filename)}>Download Video</Button>
                    </View>
                ) : isAudio && fileContent ? (
                    <View className="flex-1 justify-center items-center py-[32px] px-[24px]">
                        <MaterialCommunityIcons
                            name="music-note-outline"
                            size={64}
                            color={colors.textSecondary}
                        />
                        <Text className="text-text text-[24px] font-bold mt-[16px] mb-[8px] text-center">
                            Audio Playback Not Available
                        </Text>
                        <Text className="text-text-secondary text-[16px] text-center leading-[24px] mb-[32px]">
                            Audio playback is not supported in this viewer.{'\n'}
                            Download the file to listen to it.
                        </Text>
                        <Button onPress={() => onDownload(file.id, file.filename)}>Download Audio</Button>
                    </View>
                ) : (
                    <View className="flex-1 justify-center items-center py-[32px] px-[24px]">
                        <MaterialCommunityIcons
                            name="file-outline"
                            size={64}
                            color={colors.textSecondary}
                        />
                        <Text className="text-text text-[24px] font-bold mt-[16px] mb-[8px] text-center">
                            Preview Not Available
                        </Text>
                        <Text className="text-text-secondary text-[16px] text-center leading-[24px] mb-[32px]">
                            This file type cannot be previewed.{'\n'}
                            Download the file to view its contents.
                        </Text>
                        <Button onPress={() => onDownload(file.id, file.filename)}>Download File</Button>
                    </View>
                )}
            </ScrollView>

            {/* File Details Section - at bottom */}
            <View className="bg-card mx-[12px] mt-[8px] mb-[12px] rounded-[18px] overflow-hidden relative" style={{ zIndex: 2 }}>
                <View className="flex-row items-center justify-between px-[12px] pt-[10px] pb-[6px]">
                    <Text className="text-text text-[18px] font-semibold flex-1">
                        File Details
                    </Text>
                    <Button appearance="plain" tone="neutral" iconOnly accessibilityLabel="Toggle file details"
                        aria-expanded={showFileDetailsInViewer}
                        onPress={onToggleDetails}
                    icon={<MaterialCommunityIcons
                            name={showFileDetailsInViewer ? "chevron-up" : "chevron-down"}
                            size={20}
                            color={colors.textSecondary}
                        />} />
                </View>

                {showFileDetailsInViewer && (
                    <>
                        <View className="px-[12px] pb-[8px]">
                            <SettingsListGroup>
                                {fileDetailItems.map((item) => (
                                    <SettingsListItem
                                        key={item.id}
                                        icon={<MaterialCommunityIcons name={item.iconName} size={20} color={item.iconColor} />}
                                        title={item.title}
                                        description={item.description}
                                        showChevron={false}
                                    />
                                ))}
                            </SettingsListGroup>
                        </View>

                        {isOwner && (
                            <View className="flex-row gap-[12px] mt-[8px] px-[12px] pb-[10px]">
                                <Button tone="danger"
                                    style={{ flex: 1 }}
                                    onPress={() => {
                                        onClose();
                                        onDelete(file.id, file.filename);
                                    }}
                                >
                                    Delete
                                </Button>
                            </View>
                        )}
                    </>
                )}
            </View>
        </View>
    );
};
