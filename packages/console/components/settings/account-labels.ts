import { useMemo } from 'react';
import type { AccountKind, AccountNode, AccountRole } from '@/hooks/use-account';
import { resolveStoredImageUrl } from '@/lib/image-upload';
import { useTranslation } from '@/lib/i18n';

/** First-letter initials for an avatar fallback. */
export function accountInitials(label: string): string {
  return label.charAt(0).toUpperCase() || 'A';
}

/** Account role and kind names, resolved through the dictionary. */
export function useAccountLabels() {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      role: (role: AccountRole): string => t(`settingsPage.roles.${role}`),
      kind: (kind: AccountKind): string => t(`settingsPage.kinds.${kind}`),
      /** The role badge to show for an account row, or null for the caller's own. */
      accountRole: (node: AccountNode): string | null => {
        if (node.relationship === 'self') {
          return null;
        }
        const role = node.callerMembership?.role;
        if (role) {
          return t(`settingsPage.roles.${role}`);
        }
        return node.relationship === 'owner' ? t('settingsPage.roles.owner') : null;
      },
    }),
    [t],
  );
}

export { resolveStoredImageUrl };
