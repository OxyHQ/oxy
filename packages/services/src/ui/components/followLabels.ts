/**
 * The words on a follow button, for every verb the ecosystem uses.
 *
 * "Follow" is wrong for half the things an Oxy user can follow: you subscribe
 * to a channel, you join a community, you watch a listing. Both follow buttons
 * read their words here, translated through `@oxy.so/core`'s `follow.*`
 * strings, so a verb reads the same — and in the same language — wherever it is
 * drawn.
 */

import { useMemo } from 'react';
import { useI18n } from '../hooks/useI18n';

/**
 * The small vocabulary of verbs the ecosystem actually uses. An application
 * whose verb is not here passes `labels` instead — the escape hatch exists so
 * this union never has to grow to accommodate one product's wording.
 */
export type FollowVerb = 'follow' | 'subscribe' | 'join' | 'watch';

export interface FollowLabels {
  /** Not following yet. */
  idle: string;
  /** Following, and this application acts on it. */
  active: string;
  /** Asked, waiting for the other side to accept. */
  pending: string;
  /** Following globally, but switched off in this application. */
  disabled: string;
}

/** The labels for `verb` in the current language, with the caller's `overrides` on top. */
export function useFollowLabels(
  verb: FollowVerb = 'follow',
  overrides?: Partial<FollowLabels>,
): FollowLabels {
  const { t } = useI18n();
  return useMemo(
    () => ({
      idle: t(`follow.verbs.${verb}.idle`),
      active: t(`follow.verbs.${verb}.active`),
      pending: t('follow.pending'),
      disabled: t('follow.disabled'),
      ...overrides,
    }),
    [t, verb, overrides],
  );
}
