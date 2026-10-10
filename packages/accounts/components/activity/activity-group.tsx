import React from 'react';
import { View } from 'react-native';
import { Section } from '@/components/section';
import { AccountCard } from '@/components/ui';
import type { TranslateFn } from '@/lib/i18n';
import type { DayFormatters } from '@/utils/activity-format';
import type { ActivityGroup as ActivityGroupData } from '@/hooks/activity/useActivityGroups';
import { ActivityEventRow } from './activity-event-row';

interface ActivityGroupProps {
  group: ActivityGroupData;
  severityMode: 'light' | 'dark';
  expandedId: string | null;
  onToggle: (eventId: string) => void;
  formatters: DayFormatters;
  t: TranslateFn;
  onPressIn?: () => void;
}

/**
 * A single day/section group: a titled `Section` wrapping an `AccountCard`
 * of activity rows. Renders the events in the order provided by the grouping
 * hook, tagging first/last for rounded-corner treatment.
 */
export function ActivityGroup({
  group,
  severityMode,
  expandedId,
  onToggle,
  formatters,
  t,
  onPressIn,
}: ActivityGroupProps) {
  return (
    <Section title={group.title}>
      <AccountCard>
        <View>
          {group.activities.map((event, index) => (
            <ActivityEventRow
              key={event.id}
              event={event}
              severityMode={severityMode}
              isExpanded={expandedId === event.id}
              onToggle={onToggle}
              isFirst={index === 0}
              isLast={index === group.activities.length - 1}
              formatters={formatters}
              t={t}
              onPressIn={onPressIn}
            />
          ))}
        </View>
      </AccountCard>
    </Section>
  );
}
