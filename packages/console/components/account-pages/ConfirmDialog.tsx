import { Dialog } from '@oxy.so/bloom/dialog';
import type { ReactNode } from 'react';
import { useTranslation } from '@/lib/i18n';

/** A controlled confirm/cancel dialog. The caller closes it from `onConfirm` when the work is done. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  loading = false,
  disabled = false,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  destructive?: boolean;
  loading?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      actions={[
        { label: t('common.cancel'), color: 'cancel' },
        {
          label: confirmLabel,
          color: destructive ? 'destructive' : 'default',
          onPress: onConfirm,
          loading,
          disabled: disabled || loading,
          shouldCloseOnPress: false,
        },
      ]}
    >
      {children}
    </Dialog>
  );
}
