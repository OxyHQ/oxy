/**
 * ContactMatchesList — renders the list of address-book contacts that were
 * discovered to already have an Oxy account.
 *
 * Receives pre-resolved Oxy `User` objects (parent owns the fetch + cache) and
 * renders one row per match. Each row shows the Oxy avatar/name/handle plus a
 * follow/unfollow button driven by `useFollow`.
 */

import React, { memo, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Avatar } from '@oxyhq/bloom/avatar';
import { useFollow } from '@oxyhq/services';
import type { User } from '@oxyhq/core';
import { getAccountDisplayName, getAccountFallbackHandle, getNormalizedUserHandle } from '@oxyhq/core';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { useAvatarUrl } from '@/hooks/useAvatarUrl';

interface ContactMatch {
  /** Resolved Oxy profile (already fetched by the parent). */
  user: User;
  /** Display name from the device contact entry, shown when present. */
  localDisplayName?: string;
}

interface ContactMatchesListProps {
  matches: ContactMatch[];
}

function ContactMatchRowComponent({ match }: { match: ContactMatch }) {
  const colors = useColors();
  const { t, locale } = useTranslation();
  const userId = match.user.id ?? (match.user as { _id?: string })._id;
  const followResult = useFollow(userId);
  // Single-user mode of useFollow returns the SingleFollowResult shape.
  const single = followResult as {
    isFollowing: boolean;
    isLoading: boolean;
    toggleFollow: () => Promise<void>;
  };

  const handleToggleFollow = useCallback(async () => {
    try {
      await single.toggleFollow();
    } catch {
      // useFollow surfaces the error via the store; nothing to do here beyond
      // preventing the rejection from bubbling out and crashing the row.
    }
  }, [single]);

  // Prefer the contact-book label, then the API DTO contract (displayName → handle).
  const displayName =
    match.localDisplayName?.trim() ||
    (match.user.name?.displayName ??
      getNormalizedUserHandle(match.user) ??
      getAccountDisplayName(null, locale));
  const avatarUrl = useAvatarUrl(match.user);

  const fallbackHandle = getAccountFallbackHandle(match.user);
  const handle = fallbackHandle
    ? (match.user.username ? `@${fallbackHandle}` : fallbackHandle)
    : '';

  return (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <Avatar
        name={displayName}
        source={avatarUrl}
        size={40}
      />
      <View style={styles.identity}>
        <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
          {displayName}
        </Text>
        {handle ? (
          <Text style={[styles.handle, { color: colors.textSecondary }]} numberOfLines={1}>
            {handle}
          </Text>
        ) : null}
      </View>
      <TouchableOpacity
        onPress={handleToggleFollow}
        disabled={single.isLoading}
        accessibilityRole="button"
        accessibilityLabel={single.isFollowing ? t('sharing.contacts.syncFollowing') : t('sharing.contacts.syncFollow')}
        style={[
          styles.followButton,
          {
            backgroundColor: single.isFollowing ? colors.backgroundSecondary : colors.tint,
            borderColor: single.isFollowing ? colors.border : colors.tint,
          },
        ]}
      >
        {single.isLoading ? (
          <ActivityIndicator size="small" color={single.isFollowing ? colors.text : colors.background} />
        ) : (
          <Text
            style={[
              styles.followButtonText,
              { color: single.isFollowing ? colors.text : colors.background },
            ]}
          >
            {single.isFollowing ? t('sharing.contacts.syncFollowing') : t('sharing.contacts.syncFollow')}
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const ContactMatchRow = memo(ContactMatchRowComponent);

function ContactMatchesListComponent({ matches }: ContactMatchesListProps) {
  if (matches.length === 0) return null;
  return (
    <View>
      {matches.map((match) => {
        const key = match.user.id ?? (match.user as { _id?: string })._id ?? match.user.username;
        return <ContactMatchRow key={key} match={match} />;
      })}
    </View>
  );
}

export const ContactMatchesList = memo(ContactMatchesListComponent);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  identity: {
    flex: 1,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
  },
  handle: {
    fontSize: 13,
    marginTop: 2,
  },
  followButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
  },
  followButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
