import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { alert, toast } from '@oxy.so/bloom';
import type { ClientSession } from '@oxy.so/core';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import type { GroupedItem } from '@/components/sections/types';

interface UseActiveSessionsArgs {
  sessions: ClientSession[] | undefined;
  logoutAll: () => Promise<unknown>;
}

interface UseActiveSessionsResult {
  /** Rows for the active-sessions `GroupedSection` (empty when ≤1 session). */
  items: GroupedItem[];
}

/**
 * Owns the active-sessions section's state, item-builder, and the "log out all
 * sessions" confirmation flow. Extracted from the security screen verbatim:
 * the `isLoggingOutAll` state, the `handleLogoutAll` callback, and the
 * `activeSessionsItems` memo previously lived inline on the screen.
 *
 * A `.tsx` file because the busy row embeds an `ActivityIndicator`.
 */
export function useActiveSessions({
  sessions,
  logoutAll,
}: UseActiveSessionsArgs): UseActiveSessionsResult {
  const colors = useColors();
  const { t } = useTranslation();
  const [isLoggingOutAll, setIsLoggingOutAll] = useState(false);

  // Handle logout all sessions
  const handleLogoutAll = useCallback(async () => {
    const sessionCount = sessions?.length || 0;
    alert(
      t('security.sessions.logoutAllConfirmTitle'),
      t('security.sessions.logoutAllConfirmMessage', { count: sessionCount }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('security.sessions.logoutAllAction'),
          style: 'destructive',
          onPress: async () => {
            try {
              setIsLoggingOutAll(true);
              await logoutAll();
              toast.success(t('security.sessions.logoutAllSuccess'));
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : t('security.sessions.logoutAllFailed');
              toast.error(message);
            } finally {
              setIsLoggingOutAll(false);
            }
          },
        },
      ]
    );
  }, [logoutAll, sessions?.length, t]);

  const items = useMemo(() => {
    const result: GroupedItem[] = [];
    const activeSessionsCount = sessions?.filter((s) => s.isCurrent !== false).length || 0;

    if (activeSessionsCount > 1) {
      result.push({
        id: 'logout-all',
        icon: 'logout',
        iconColor: colors.error,
        title: t('security.sessions.logoutAll'),
        subtitle: t('security.sessions.logoutAllSubtitle', { count: activeSessionsCount - 1 }),
        onPress: handleLogoutAll,
        showChevron: false,
        customContent: isLoggingOutAll ? (
          <ActivityIndicator size="small" color={colors.error} />
        ) : undefined,
      });
    }

    return result;
  }, [sessions, handleLogoutAll, isLoggingOutAll, colors.error, t]);

  return { items };
}
