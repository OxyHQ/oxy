/**
 * The follow button's product rules, without the button.
 *
 * Pure: no React, no Bloom. `FollowTargetButton` renders them, and an
 * application drawing its own affordance (a chip grid, a compact row) imports
 * them from here — through `@oxy.so/services/ui/client` — without paying for the
 * button's dropdown menu.
 *
 * The menu's words are `@oxy.so/core`'s `follow.*` strings, read through the
 * caller's `t`; without one they are English.
 */

import type { FollowApplicationMode } from '@oxy.so/contracts';
import { translate } from '@oxy.so/core';
import type { Translate } from '../hooks/useI18n';
import type { FollowVerb } from './followLabels';

/** A timed-follow choice offered in the menu. */
export interface FollowDuration {
  /** The duration as it reads inside a sentence: "24 hours", "a week". */
  label: string;
  seconds: number;
}

/** The fallback language for a caller that passes no translator. */
const english: Translate = (key, vars) => translate(undefined, key, vars);

/**
 * Whether an action leaves the target ACTIVE in this application.
 *
 * One table, read by both the primary button and the menu, because the same
 * action reached from two controls once reported differently — and a rule
 * living in two switch statements is a rule that drifts. `Record` rather than
 * a function with a default, so a new action is a compile error instead of a
 * silent `false`.
 */
export const FOLLOW_ACTION_LEAVES_ACTIVE: Record<
  'follow' | 'follow-timed' | 'enable-here' | 'disable-here' | 'unfollow',
  boolean
> = {
  follow: true,
  'follow-timed': true,
  // Re-enabling here does not change the global follow — the user already had
  // it — but it does change whether this application acts on it, which is what
  // a mirror is asking about.
  'enable-here': true,
  'disable-here': false,
  unfollow: false,
};

/** One line in the disclosure menu. */
export interface FollowMenuItem {
  key: string;
  label: string;
  /** What the component should call. Named so the table below stays pure. */
  action:
    | { type: 'follow-timed'; seconds: number; durationLabel: string }
    | { type: 'enable-here' }
    | { type: 'disable-here' }
    | { type: 'unfollow' };
}

/**
 * What the main button should do for the current state.
 *
 * Exported because the product rule is not obvious from the label alone: a
 * follow switched off here still reads as "following" globally, so the primary
 * press must re-enable here — not unfollow everywhere.
 */
export function resolveFollowPrimaryAction(input: {
  isFollowing: boolean;
  applicationMode: FollowApplicationMode;
}): 'follow' | 'unfollow' | 'enable-here' {
  if (!input.isFollowing) return 'follow';
  if (input.applicationMode === 'disabled') return 'enable-here';
  return 'unfollow';
}

/**
 * Which choices exist, given the state.
 *
 * Pure and exported because this is the product decision, not a rendering
 * detail: a timed follow is only offered before following, turning it off here
 * is only offered while following, and NEITHER is offered before the server has
 * answered — every one of them addresses a relationship that does not exist
 * yet, so offering them mid-write would mean sending a guessed id.
 */
export function buildFollowMenuItems(input: {
  following: boolean;
  applicationMode: FollowApplicationMode;
  hasRelationship: boolean;
  isPending: boolean;
  durations: FollowDuration[] | false;
  /** The button's idle label, which a timed choice starts with: "Follow for 24 hours". */
  idleVerb: string;
  applicationName: string;
  /** Words the "everywhere" line with this verb: "Leave everywhere". Default `follow`. */
  verb?: FollowVerb;
  /** `useI18n().t`, for the menu in the app's language. Default English. */
  t?: Translate;
}): FollowMenuItem[] {
  const t = input.t ?? english;
  const items: FollowMenuItem[] = [];

  if (!input.following) {
    if (input.durations === false) return items;
    for (const d of input.durations) {
      items.push({
        key: `for-${d.seconds}`,
        label: t('follow.menu.forDuration', { label: input.idleVerb, duration: d.label }),
        action: { type: 'follow-timed', seconds: d.seconds, durationLabel: d.label },
      });
    }
    return items;
  }

  if (!input.hasRelationship || input.isPending) return items;

  items.push(
    input.applicationMode === 'disabled'
      ? {
          key: 'enable-here',
          label: t('follow.menu.showIn', { app: input.applicationName }),
          action: { type: 'enable-here' },
        }
      : {
          key: 'disable-here',
          label: t('follow.menu.hideIn', { app: input.applicationName }),
          action: { type: 'disable-here' },
        },
  );
  items.push({
    // Named for what it does. "Unfollow" beside "don't show here" would read as
    // the same action twice, and the user would pick the wrong one.
    key: 'unfollow-everywhere',
    label: t(`follow.verbs.${input.verb ?? 'follow'}.everywhere`),
    action: { type: 'unfollow' },
  });

  return items;
}
