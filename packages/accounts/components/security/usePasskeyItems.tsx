import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { alert, toast } from '@oxyhq/bloom';
import { isOxyRpOrigin } from '@oxyhq/core';
import { useAuthMethods, useOxy } from '@oxyhq/services';
import { useColors } from '@/hooks/useColors';
import { useTranslation, useLocale } from '@/lib/i18n';
import type { GroupedItem } from '@/components/sections/types';

/** A single registered passkey, as projected by `useAuthMethods().passkeys`. */
type PasskeyMethod = ReturnType<typeof useAuthMethods>['passkeys'][number];

/**
 * WebAuthn ceremony errors that mean the user simply dismissed / cancelled the
 * browser prompt — not a real failure. `@simplewebauthn/browser` wraps the raw
 * `DOMException` (`NotAllowedError` on dismiss) as the thrown error's `cause`,
 * and reports an aborted ceremony via `code: 'ERROR_CEREMONY_ABORTED'`. Detect
 * all three shapes so a cancel shows a friendly toast instead of a scary error.
 */
const CANCELLED_CEREMONY_NAMES = new Set(['NotAllowedError', 'AbortError']);

function isCancelledPasskeyCeremony(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (CANCELLED_CEREMONY_NAMES.has(error.name)) return true;
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  if (code === 'ERROR_CEREMONY_ABORTED') return true;
  return cause instanceof Error && CANCELLED_CEREMONY_NAMES.has(cause.name);
}

/**
 * Builds the passkey rows for the "How you sign in" section: one row per
 * registered passkey (name + added date + a trailing remove button) followed by
 * an "Add a passkey" CTA that runs the browser WebAuthn ceremony.
 *
 * WEB-ONLY and gated on {@link isOxyRpOrigin} — passkeys minted with Oxy's RP id
 * can only be created/asserted from a first-party Oxy web origin. Returns `[]`
 * on native or a non-Oxy origin, mirroring the native-only biometric block in
 * `useSignInItems`. A `.tsx` file because the rows embed JSX (the remove button
 * / activity indicators).
 */
export function usePasskeyItems(): GroupedItem[] {
  const colors = useColors();
  const { t } = useTranslation();
  const { locale } = useLocale();
  const { addPasskey, removePasskey } = useOxy();

  const enabled = Platform.OS === 'web' && isOxyRpOrigin();
  const { passkeys } = useAuthMethods({ enabled });

  const [isAdding, setIsAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }),
    [locale],
  );

  const handleAdd = useCallback(async () => {
    setIsAdding(true);
    try {
      await addPasskey();
      toast.success(t('security.passkeys.addSuccess'));
    } catch (error: unknown) {
      if (isCancelledPasskeyCeremony(error)) {
        toast.info(t('security.passkeys.addCancelled'));
      } else {
        const message = error instanceof Error ? error.message : '';
        toast.error(message || t('security.passkeys.addFailed'));
      }
    } finally {
      setIsAdding(false);
    }
  }, [addPasskey, t]);

  const handleRemove = useCallback(
    (passkey: PasskeyMethod) => {
      const credentialId = passkey.credentialId;
      if (!credentialId) return;
      alert(
        t('security.passkeys.removeConfirmTitle'),
        t('security.passkeys.removeConfirmMessage'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('security.passkeys.removeAction'),
            style: 'destructive',
            onPress: async () => {
              setRemovingId(credentialId);
              try {
                await removePasskey(credentialId);
                toast.success(t('security.passkeys.removeSuccess'));
              } catch (error: unknown) {
                const message = error instanceof Error ? error.message : '';
                toast.error(message || t('security.passkeys.removeFailed'));
              } finally {
                setRemovingId(null);
              }
            },
          },
        ],
      );
    },
    [removePasskey, t],
  );

  return useMemo(() => {
    if (!enabled) return [];

    const items: GroupedItem[] = [];

    for (const passkey of passkeys) {
      const credentialId = passkey.credentialId;
      if (!credentialId) continue;

      const addedDate = passkey.linkedAt ? new Date(passkey.linkedAt) : null;
      const subtitle =
        addedDate && !Number.isNaN(addedDate.getTime())
          ? t('security.passkeys.addedOn', { date: dateFormatter.format(addedDate) })
          : undefined;
      const isRemoving = removingId === credentialId;

      items.push({
        id: `passkey-${credentialId}`,
        icon: 'key-variant',
        iconColor: colors.sidebarIconSecurity,
        title: passkey.name?.trim() || t('security.passkeys.unnamed'),
        subtitle,
        showChevron: false,
        customContent: isRemoving ? (
          <ActivityIndicator size="small" color={colors.error} />
        ) : (
          <TouchableOpacity
            onPress={() => handleRemove(passkey)}
            accessibilityRole="button"
            accessibilityLabel={t('security.passkeys.removeA11yLabel')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="trash-outline" size={20} color={colors.error} />
          </TouchableOpacity>
        ),
      });
    }

    // "Add a passkey" CTA — always last. Disabled (and shows a spinner) while a
    // ceremony is in flight so a double-tap can't launch two prompts.
    items.push({
      id: 'add-passkey',
      icon: 'key-plus',
      iconColor: colors.success,
      title: t('security.passkeys.addTitle'),
      subtitle: t('security.passkeys.addSubtitle'),
      onPress: isAdding ? undefined : handleAdd,
      disabled: isAdding,
      showChevron: false,
      customContent: isAdding ? (
        <ActivityIndicator size="small" color={colors.success} />
      ) : undefined,
    });

    return items;
  }, [enabled, passkeys, removingId, isAdding, colors, dateFormatter, handleAdd, handleRemove, t]);
}
