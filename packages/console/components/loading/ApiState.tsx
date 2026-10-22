import {
  AdmonitionButton,
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';

import { useTranslation } from '@/lib/i18n';
import { classifyApiError } from '@/lib/api-error';

/**
 * A failed read, said once in fixed copy. 403 and 404 are answers (EmptyState, no retry:
 * the same request is refused again); everything else is an Admonition with retry. The
 * error's own message is never shown.
 */
export function ApiState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  const kind = classifyApiError(error);

  if (kind === 'forbidden' || kind === 'missing') {
    return (
      <EmptyState
        icon={kind === 'forbidden' ? RiLockLine : RiSearchLine}
        title={t(`state.${kind}.title`)}
        description={t(`state.${kind}.body`)}
      />
    );
  }

  return (
    <AdmonitionRoot type="error">
      <AdmonitionRow>
        <AdmonitionIcon />
        <AdmonitionContent>
          <AdmonitionText style={{ fontWeight: '600' }}>{t(`state.${kind}.title`)}</AdmonitionText>
          <AdmonitionText>{t(`state.${kind}.body`)}</AdmonitionText>
        </AdmonitionContent>
        {onRetry ? (
          <AdmonitionButton
            appearance="subtle"
            tone="neutral"
            leadingIcon={RiRefreshLine}
            onPress={onRetry}
          >
            {t('state.retry')}
          </AdmonitionButton>
        ) : null}
      </AdmonitionRow>
    </AdmonitionRoot>
  );
}
