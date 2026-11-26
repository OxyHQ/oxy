import { SpinnerIcon } from '@oxy.so/bloom/loading';
import type React from 'react';
import { useMemo, useState, useEffect } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { ExpoImage } from '../ExpoImage';
import MaterialCommunityIcons from '../../icons/MaterialCommunityIcons';
import { useTheme } from '@oxy.so/bloom/theme';
import type { FileMetadata } from '@oxy.so/core';
import { formatFileSize } from '../../utils/fileManagement';
import { getImageSize } from '../../utils/imageSize';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { createTokenStyles } from '@oxy.so/bloom/theme';

interface FileViewerProps {
  file: FileMetadata;
  fileContent: string | null;
  loadingFileContent: boolean;
  showFileDetailsInViewer: boolean;
  onToggleDetails: () => void;
  onClose: () => void;
  onDownload: (fileId: string, filename: string) => void;
  /** Removes the file from the library: to trash, or for good if it is blocked. */
  onDelete: (fileId: string, filename: string) => void;
  /** The remove button's label — "Move to trash", or "Delete" for a blocked file. */
  deleteLabel: string;
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
  deleteLabel,
  isOwner,
}) => {
  const styles = useStyles();
  const { colors } = useTheme();
  const isImage = file.contentType.startsWith('image/');
  const isText =
    file.contentType.startsWith('text/') ||
    file.contentType.includes('json') ||
    file.contentType.includes('xml') ||
    file.contentType.includes('javascript') ||
    file.contentType.includes('typescript');
  const isPDF = file.contentType.includes('pdf');
  const isVideo = file.contentType.startsWith('video/');
  const isAudio = file.contentType.startsWith('audio/');

  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(
    null,
  );

  // Load image dimensions when image content is available
  useEffect(() => {
    if (!isImage || !fileContent) {
      setImageDimensions(null);
      return;
    }
    // A newer file may replace this one before its size arrives.
    let current = true;
    getImageSize(fileContent).then(
      (size) => {
        if (current) setImageDimensions(size);
      },
      () => {
        // Fallback if dimensions can't be loaded
        if (current) setImageDimensions({ width: 400, height: 400 });
      },
    );
    return () => {
      current = false;
    };
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
    const items: Array<{
      id: string;
      iconName: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
      iconColor: string;
      title: string;
      description: string;
    }> = [
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
    <View style={[styles.viewer, isImage && fileContent ? null : styles.viewerBackground]}>
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
          <View style={[styles.overlay, { backgroundColor: colors.overlay, zIndex: 1 }]} />
        </>
      )}

      {/* Floating Back Button */}
      <Button
        appearance="subtle"
        tone="neutral"
        iconOnly
        accessibilityLabel="Back"
        style={[styles.button, { zIndex: 10 }]}
        onPress={onClose}
        icon={<MaterialCommunityIcons name="arrow-left" size={20} color={colors.text} />}
      />

      {/* Floating Download Button */}
      <Button
        appearance="subtle"
        tone="neutral"
        iconOnly
        accessibilityLabel="Download"
        style={[styles.button2, { zIndex: 10 }]}
        onPress={() => onDownload(file.id, file.filename)}
        icon={<MaterialCommunityIcons name="download" size={20} color={colors.primary} />}
      />

      {/* File Content */}
      <ScrollView style={[styles.container, { zIndex: 2 }]} contentContainerStyle={styles.content}>
        {loadingFileContent ? (
          <View style={styles.centered}>
            <SpinnerIcon size={32} color={colors.primary} />
            <Text style={styles.text}>Loading file content...</Text>
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
              style={[
                styles.container2,
                {
                  width: imageDisplaySize.width,
                  height: imageDisplaySize.height,
                },
              ]}
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
          <View style={[styles.surface, { maxHeight: '80%' }]}>
            <ScrollView style={styles.fill} nestedScrollEnabled>
              <Text style={[styles.text2, { fontFamily: 'monospace' }]}>{fileContent}</Text>
            </ScrollView>
          </View>
        ) : isPDF && fileContent ? (
          <View style={styles.centered2}>
            <MaterialCommunityIcons name="file-pdf-box" size={64} color={colors.textSecondary} />
            <Text style={styles.title}>PDF Preview Not Available</Text>
            <Text style={styles.mutedText}>
              PDF files cannot be previewed in this viewer.{'\n'}
              Download the file to view its contents.
            </Text>
            <Button onPress={() => onDownload(file.id, file.filename)}>Download PDF</Button>
          </View>
        ) : isVideo && fileContent ? (
          <View style={styles.centered2}>
            <MaterialCommunityIcons name="video-outline" size={64} color={colors.textSecondary} />
            <Text style={styles.title}>Video Playback Not Available</Text>
            <Text style={styles.mutedText}>
              Video playback is not supported in this viewer.{'\n'}
              Download the file to view it.
            </Text>
            <Button onPress={() => onDownload(file.id, file.filename)}>Download Video</Button>
          </View>
        ) : isAudio && fileContent ? (
          <View style={styles.centered2}>
            <MaterialCommunityIcons
              name="music-note-outline"
              size={64}
              color={colors.textSecondary}
            />
            <Text style={styles.title}>Audio Playback Not Available</Text>
            <Text style={styles.mutedText}>
              Audio playback is not supported in this viewer.{'\n'}
              Download the file to listen to it.
            </Text>
            <Button onPress={() => onDownload(file.id, file.filename)}>Download Audio</Button>
          </View>
        ) : (
          <View style={styles.centered2}>
            <MaterialCommunityIcons name="file-outline" size={64} color={colors.textSecondary} />
            <Text style={styles.title}>Preview Not Available</Text>
            <Text style={styles.mutedText}>
              This file type cannot be previewed.{'\n'}
              Download the file to view its contents.
            </Text>
            <Button onPress={() => onDownload(file.id, file.filename)}>Download File</Button>
          </View>
        )}
      </ScrollView>

      {/* File Details Section - at bottom */}
      <View style={[styles.surface2, { zIndex: 2 }]}>
        <View style={styles.row}>
          <Text style={styles.title2}>File Details</Text>
          <Button
            appearance="plain"
            tone="neutral"
            iconOnly
            accessibilityLabel="Toggle file details"
            aria-expanded={showFileDetailsInViewer}
            onPress={onToggleDetails}
            icon={
              <MaterialCommunityIcons
                name={showFileDetailsInViewer ? 'chevron-up' : 'chevron-down'}
                size={20}
                color={colors.textSecondary}
              />
            }
          />
        </View>

        {showFileDetailsInViewer && (
          <>
            <View style={styles.section}>
              <GroupedSection>
                {fileDetailItems.map((item) => (
                  <GroupedSectionItem
                    key={item.id}
                    icon={
                      <MaterialCommunityIcons
                        name={item.iconName}
                        size={20}
                        color={item.iconColor}
                      />
                    }
                    title={item.title}
                    description={item.description}
                    showChevron={false}
                  />
                ))}
              </GroupedSection>
            </View>

            {isOwner && (
              <View style={styles.row2}>
                <Button
                  tone="danger"
                  style={{ flex: 1 }}
                  onPress={() => {
                    onClose();
                    onDelete(file.id, file.filename);
                  }}
                >
                  {deleteLabel}
                </Button>
              </View>
            )}
          </>
        )}
      </View>
    </View>
  );
};

const useStyles = createTokenStyles((t) => ({
  viewer: { position: 'relative', flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  viewerBackground: { backgroundColor: t.background },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  button: { position: 'absolute', top: 12, left: 12 },
  button2: { position: 'absolute', top: 12, right: 12 },
  container: { position: 'relative', flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  content: { flexGrow: 1, paddingHorizontal: 12, paddingTop: 0, paddingBottom: 8 },
  centered: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { marginTop: 16, fontSize: 16, color: t.foreground },
  container2: { alignSelf: 'center', overflow: 'hidden', borderRadius: 24 },
  surface: {
    minHeight: 180,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    borderRadius: 18,
    backgroundColor: t.card,
    padding: 12,
  },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  text2: { fontSize: 14, lineHeight: 20, color: t.foreground },
  centered2: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  title: {
    marginTop: 16,
    marginBottom: 8,
    textAlign: 'center',
    fontSize: 24,
    fontWeight: 700,
    color: t.foreground,
  },
  mutedText: {
    marginBottom: 32,
    textAlign: 'center',
    fontSize: 16,
    lineHeight: 24,
    color: t.mutedForeground,
  },
  surface2: {
    position: 'relative',
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 12,
    overflow: 'hidden',
    borderRadius: 18,
    backgroundColor: t.card,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
  },
  title2: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: 18,
    fontWeight: 600,
    color: t.foreground,
  },
  section: { paddingHorizontal: 12, paddingBottom: 8 },
  row2: { marginTop: 8, flexDirection: 'row', gap: 12, paddingHorizontal: 12, paddingBottom: 10 },
}));
