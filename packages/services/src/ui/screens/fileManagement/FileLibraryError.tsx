import type React from 'react';
import { View, StyleSheet } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
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
}) => (
  <View style={styles.container}>
    <Ionicons name="cloud-offline-outline" size={64} color={iconColor} />
    <Text style={[styles.title, { color: titleColor }]}>{title}</Text>
    <Text style={[styles.text, { color: descriptionColor }]}>{description}</Text>
    <Button onPress={onRetry} accessibilityLabel={retryLabel}>
      {retryLabel}
    </Button>
  </View>
);

export default FileLibraryError;

const styles = StyleSheet.create({
  container: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 40 },
  title: { marginTop: 16, marginBottom: 8, textAlign: 'center', fontSize: 24, fontWeight: 700 },
  text: { marginBottom: 32, textAlign: 'center', fontSize: 16, lineHeight: 24 },
});
