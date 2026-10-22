import { Badge } from '@oxy.so/bloom/badge';

import { useTranslation } from '@/lib/i18n';

type StatusColor = 'success' | 'warning' | 'error' | 'default';

const STATUS: Record<string, { color: StatusColor; solid: boolean }> = {
  active: { color: 'success', solid: true },
  pending_review: { color: 'warning', solid: false },
  suspended: { color: 'error', solid: false },
  deleted: { color: 'default', solid: false },
};

/** An application's lifecycle status; an unknown value reads as inactive, never as active. */
export function ApplicationStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const known = status in STATUS ? status : 'inactive';
  const { color, solid } = STATUS[known] ?? { color: 'default' as const, solid: false };
  return (
    <Badge
      content={t(`applications.status.${known}`)}
      size="label-small"
      variant={solid ? 'solid' : 'subtle'}
      color={color}
    />
  );
}
