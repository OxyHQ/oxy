import type React from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { Text } from '@oxy.so/bloom/typography';
import { ExpoImage } from '../ExpoImage';
import Ionicons from '../../icons/Ionicons';
import { Dialog, type DialogControlProps } from '@oxy.so/bloom/dialog';
import { useTheme } from '@oxy.so/bloom/theme';
import { formatFileSize, getFileIcon } from '../../utils/fileManagement';
import type { PendingUploadFile } from '../../screens/fileManagement/shared';
import { createTokenStyles } from '@oxy.so/bloom/theme';

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
}> = ({ pendingFiles, onConfirm, onCancel, onRemoveFile, showActions = true }) => {
  const styles = useStyles();
  const { colors } = useTheme();
  const totalSize = pendingFiles.reduce((sum, f) => sum + f.size, 0);

  return (
    <View style={styles.surface}>
      <View style={styles.row}>
        <Text style={styles.title}>Review Files ({pendingFiles.length})</Text>
        <Button
          appearance="plain"
          tone="neutral"
          iconOnly
          accessibilityLabel="Close upload preview"
          onPress={onCancel}
          icon={<Ionicons name="close" size={24} color={colors.text} />}
        />
      </View>

      <ScrollView style={styles.container}>
        {pendingFiles.map((pendingFile) => {
          const isImage = pendingFile.type.startsWith('image/');
          return (
            <Card key={pendingFile.id} appearance="subtle" style={styles.card}>
              {isImage && pendingFile.preview ? (
                <ExpoImage
                  source={{ uri: pendingFile.preview }}
                  style={previewStyles.thumbnail}
                  contentFit="cover"
                />
              ) : (
                <View style={[styles.centered, { backgroundColor: colors.backgroundSecondary }]}>
                  <Ionicons name={getFileIcon(pendingFile.type)} size={32} color={colors.primary} />
                </View>
              )}
              <View style={styles.container2}>
                <Text style={styles.title2} numberOfLines={1}>
                  {pendingFile.name}
                </Text>
                <Text style={styles.mutedText}>
                  {formatFileSize(pendingFile.size)} • {pendingFile.type}
                </Text>
              </View>
              <Button
                appearance="plain"
                tone="danger"
                iconOnly
                accessibilityLabel={`Remove ${pendingFile.name}`}
                onPress={() => onRemoveFile(pendingFile.id)}
                icon={<Ionicons name="close-circle" size={24} color={colors.error} />}
              />
            </Card>
          );
        })}
      </ScrollView>

      <View style={styles.container3}>
        <View style={styles.row2}>
          <Text style={styles.title3}>
            {pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''}
          </Text>
          <Text style={styles.title3}>{formatFileSize(totalSize)}</Text>
        </View>
        {showActions && (
          <View style={styles.row3}>
            <Button appearance="subtle" tone="neutral" style={{ flex: 1 }} onPress={onCancel}>
              Cancel
            </Button>
            <Button style={{ flex: 2 }} onPress={onConfirm}>
              Upload
            </Button>
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

const useStyles = createTokenStyles((t) => ({
  surface: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', backgroundColor: t.background },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderColor: t.border,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  title: { fontSize: 20, fontWeight: 700, color: t.foreground },
  container: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', padding: 16 },
  card: { marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  centered: {
    height: 60,
    width: 60,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  container2: { minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  title2: { marginBottom: 4, fontSize: 16, fontWeight: 600, color: t.foreground },
  mutedText: { fontSize: 13, color: t.mutedForeground },
  container3: { borderTopWidth: 1, borderColor: t.border, padding: 16 },
  row2: { marginBottom: 16, flexDirection: 'row', justifyContent: 'space-between' },
  title3: { fontSize: 15, fontWeight: 600, color: t.foreground },
  row3: { flexDirection: 'row', gap: 12 },
}));
