import type React from 'react';
import { View, StyleSheet } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { Card } from '@oxy.so/bloom/card';
import { Loading } from '@oxy.so/bloom/loading';
import { Meter } from '@oxy.so/bloom/stat-bar';

export interface UploadBarProps {
  uploadProgress: { current: number; total: number } | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

/** Upload state is app-owned; surface, spinner and determinate meter are Bloom. */
const UploadBar: React.FC<UploadBarProps> = ({ uploadProgress, t }) => (
  <View style={[styles.overlay, { pointerEvents: 'none' }]}>
    <Card appearance="solid" elevation="s" radius="radius-max" style={styles.card}>
      <View style={styles.container}>
        <Text variant="caption-1-medium">
          {t('fileManagement.uploading')}
          {uploadProgress ? ` ${uploadProgress.current}/${uploadProgress.total}` : '…'}
        </Text>
        {uploadProgress && uploadProgress.total > 0 ? (
          <Meter
            value={uploadProgress.current}
            max={uploadProgress.total}
            height={3}
            accessibilityLabel={t('fileManagement.uploading')}
          />
        ) : null}
      </View>
      <Loading size="sm" />
    </Card>
  </View>
);

export default UploadBar;

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 72, right: 0, left: 0, zIndex: 50, alignItems: 'center' },
  card: {
    minWidth: 200,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  container: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', gap: 6 },
});
