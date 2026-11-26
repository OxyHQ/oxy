import type React from 'react';
import { View } from 'react-native';
import { Card } from '@oxy.so/bloom/card';
import { Text } from '@oxy.so/bloom/typography';
import Ionicons from '../../icons/Ionicons';
import { Button } from '@oxy.so/bloom/button';
import { useTheme } from '@oxy.so/bloom/theme';
import { surfaces, type SurfaceControls } from '@oxy.so/bloom/surfaces';
import type { FileMetadata } from '@oxy.so/core';
import { useI18n } from '../../hooks/useI18n';
import { formatFileSize, getFileIcon } from '../../utils/fileManagement';
import { FileAppAccessSection } from './FileAppAccessSection';
import { createTokenStyles } from '@oxy.so/bloom/theme';

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
 * icon + metadata, for the owner the applications that can open it ("Apps with
 * access", ADR 0043 stage 4c), plus download / delete / cancel actions. Each action first
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
  const styles = useStyles();
  const { t } = useI18n();
  const { colors } = useTheme();

  return (
    <View>
      <Card appearance="subtle" style={styles.card}>
        <View style={styles.section}>
          <Ionicons name={getFileIcon(file.contentType)} size={64} color={colors.primary} />
        </View>

        <Text style={styles.title}>{file.filename}</Text>

        <View style={styles.container}>
          <View style={styles.row}>
            <Text style={styles.mutedText}>{t('fileManagement.size')}:</Text>
            <Text style={styles.text}>{formatFileSize(file.length)}</Text>
          </View>

          <View style={styles.row}>
            <Text style={styles.mutedText}>{t('fileManagement.details.type')}:</Text>
            <Text style={styles.text}>{file.contentType}</Text>
          </View>

          <View style={styles.row}>
            <Text style={styles.mutedText}>{t('fileManagement.details.uploaded')}:</Text>
            <Text style={styles.text}>{new Date(file.uploadDate).toLocaleString()}</Text>
          </View>

          {file.metadata?.description && (
            <View style={styles.row}>
              <Text style={styles.mutedText}>{t('fileManagement.details.description')}:</Text>
              <Text style={styles.text}>{file.metadata.description}</Text>
            </View>
          )}
        </View>

        {isOwner ? <FileAppAccessSection fileId={file.id} /> : null}
      </Card>

      <View style={{ gap: 8 }}>
        <Button
          appearance="solid"
          tone="accent"
          onPress={() => {
            surface.dismiss();
            onDownload(file.id, file.filename);
          }}
        >
          {t('fileManagement.details.download')}
        </Button>
        {isOwner ? (
          <Button
            appearance="solid"
            tone="danger"
            onPress={() => {
              surface.dismiss();
              onDelete(file.id, file.filename);
            }}
          >
            {t('common.actions.delete')}
          </Button>
        ) : null}
        <Button appearance="subtle" tone="neutral" onPress={() => surface.dismiss()}>
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
  void surfaces.present((surface) => <FileDetailsModal surface={surface} {...options} />);
}

const useStyles = createTokenStyles((t) => ({
  card: { alignItems: 'center', padding: 18 },
  section: { marginBottom: 16 },
  title: {
    marginBottom: 24,
    textAlign: 'center',
    fontSize: 20,
    fontWeight: 700,
    color: t.foreground,
  },
  container: { marginBottom: 32, width: '100%' },
  row: {
    marginBottom: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  mutedText: {
    minWidth: 100,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: 16,
    fontWeight: 500,
    color: t.mutedForeground,
  },
  text: {
    flexGrow: 2,
    flexShrink: 1,
    flexBasis: '0%',
    textAlign: 'right',
    fontSize: 16,
    color: t.foreground,
  },
}));
