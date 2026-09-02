/**
 * The date and greeting that head the inbox: today's date as the screen
 * heading, the personalized greeting under it, and the AI daily brief as body
 * copy. The brief generates itself once per day, so there is nothing to press.
 *
 * Rendered as the inbox list's header rather than as its own screen — it is a
 * few lines of context above the messages, not a destination.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useOxy } from '@oxyhq/services';
import { SPACING as BLOOM_SPACING } from '@oxyhq/bloom/design-tokens';

import { useColors } from '@/constants/theme';
import { useDailyBrief } from '@/hooks/queries/useDailyBrief';
import { useInboxPrefs } from '@/contexts/inbox-prefs-context';
import type { Message } from '@/services/emailApi';

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()
  );
}

export function InboxGreeting({ messages }: { messages: Message[] }) {
  const colors = useColors();
  const { user } = useOxy();
  const { prefs } = useInboxPrefs();

  // Refreshed on focus so the date self-heals when the day rolls over while
  // the app sits open.
  const [today, setToday] = useState(() => new Date());
  useFocusEffect(
    useCallback(() => {
      const now = new Date();
      setToday((prev) => (isSameDay(prev, now) ? prev : now));
    }, []),
  );

  const dayMessages = useMemo(
    () => messages.filter((m) => isSameDay(new Date(m.date), today)),
    [messages, today],
  );

  const { briefText, isStreaming, isLoading, error } = useDailyBrief(dayMessages, {
    enabled: prefs.aiBrief,
  });

  const dateLabel = useMemo(
    () => today.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }),
    [today],
  );

  const greetingName = user?.name.displayName ?? '';
  const greetingLine = greetingName ? `${getGreeting()} ${greetingName}` : getGreeting();

  /**
   * The brief line always says something. Streaming text wins as soon as there
   * is any; otherwise every state — generating, failed, nothing to summarize —
   * has its own copy, so the line is never blank.
   */
  const briefLine = useMemo(() => {
    if (briefText) return briefText;
    if (isLoading || isStreaming) return 'Writing your brief…';
    if (error) return "Couldn't write today's brief.";
    if (dayMessages.length === 0) return 'Nothing new today.';
    return 'Preparing your brief…';
  }, [briefText, isLoading, isStreaming, error, dayMessages.length]);

  return (
    <View style={styles.container}>
      <Text style={[styles.date, { color: colors.unread }]}>{dateLabel}</Text>
      <Text style={[styles.greeting, { color: colors.unread }]}>{greetingLine}</Text>

      {prefs.aiBrief ? (
        <Text style={[styles.briefText, { color: colors.secondaryText }]}>{briefLine}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: BLOOM_SPACING['space-16'],
    // Same inset above and below the block.
    paddingVertical: BLOOM_SPACING['space-16'],
    gap: BLOOM_SPACING['space-8'],
  },
  date: {
    // A small label above the greeting, which is the block's real headline.
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
    lineHeight: 22,
  },
  greeting: {
    fontSize: 22,
    fontWeight: '400',
    lineHeight: 30,
  },
  briefText: {
    fontSize: 15,
    lineHeight: 21,
  },
});
