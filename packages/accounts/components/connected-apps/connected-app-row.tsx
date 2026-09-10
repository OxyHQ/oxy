import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Avatar } from '@oxy.so/bloom/avatar';
import type { ConnectedApp } from '@oxy.so/core';
import { useColors } from '@/hooks/useColors';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { useTranslation } from '@/lib/i18n';

interface ConnectedAppRowProps {
  app: ConnectedApp;
  /**
   * Resolved logo URL. Either the app's full `logoUrl` (when it is an absolute
   * URL) or the resolved download URL of a bare file id. `undefined` falls back
   * to {@link Avatar}'s name-derived initials.
   */
  logoUri?: string;
  /** Renders the rounded top corners when this is the first row in the card. */
  isFirst: boolean;
  /** Adds a hairline divider above every row except the first. */
  hasDivider: boolean;
  /** Shows a spinner in the revoke control while this app is being revoked. */
  isRevoking: boolean;
  onRevoke: () => void;
}

/**
 * A single connected-application row: the app's logo, its name, the granted
 * scopes, when it was last used, and a destructive "Revoke" control. Mirrors the
 * visual language of the security devices/sessions rows (avatar + text stack +
 * trailing action) but carries two metadata lines instead of one.
 */
export function ConnectedAppRow({
  app,
  logoUri,
  isFirst,
  hasDivider,
  isRevoking,
  onRevoke,
}: ConnectedAppRowProps) {
  const colors = useColors();
  const { t } = useTranslation();
  const handlePressIn = useHapticPress();
  const formatRelativeTime = useRelativeTime();

  const scopesLabel =
    app.scopes.length > 0 ? app.scopes.join(', ') : t('connectedApps.noScopes');
  const lastUsedLabel = t('connectedApps.lastUsed', {
    time: formatRelativeTime(app.lastUsedAt, t('common.unknown')),
  });

  return (
    <View
      style={[
        styles.row,
        { backgroundColor: colors.card },
        hasDivider && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
        isFirst && styles.firstRow,
      ]}
    >
      <Avatar name={app.name} source={logoUri} size={44} />
      <View style={styles.body}>
        <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
          {app.name}
        </Text>
        <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={2}>
          {scopesLabel}
        </Text>
        <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={1}>
          {lastUsedLabel}
        </Text>
      </View>
      <TouchableOpacity
        style={[styles.revokeButton, { borderColor: colors.error }]}
        onPressIn={handlePressIn}
        onPress={onRevoke}
        disabled={isRevoking}
        accessibilityRole="button"
        accessibilityLabel={t('connectedApps.revokeA11y', { name: app.name })}
        accessibilityState={{ disabled: isRevoking }}
      >
        {isRevoking ? (
          <ActivityIndicator size="small" color={colors.error} />
        ) : (
          <Text style={[styles.revokeText, { color: colors.error }]}>
            {t('connectedApps.revoke')}
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 14,
    gap: 12,
  },
  firstRow: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
  },
  meta: {
    fontSize: 13,
    lineHeight: 18,
  },
  revokeButton: {
    minWidth: 78,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  revokeText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
