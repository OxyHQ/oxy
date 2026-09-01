/**
 * Message row shared by the inbox list and search results.
 *
 * The row is `[avatar] [block]`, where the block is two stacked lines:
 * a headline row carrying the sender and, as its sibling, the timestamp —
 * swapped for the row actions (archive / trash / read / pin) on hover — and
 * below it the subject + snippet summary. The avatar doubles as the selection
 * checkbox while hovered.
 *
 * `MessageRowExtras` renders everything else the message carries: a chip line
 * (importance, sentiment, labels) and a horizontal rail of cards for the
 * extracted smart card and any attachments.
 *
 * Hover is tracked in React state rather than `group-hover:` because the web
 * build has no verified NativeWind hover pipeline; the state approach behaves
 * identically and is inert on native, where the actions are never revealed.
 */

import React, { useCallback, useState, useRef } from 'react';
import { View, Pressable, TouchableOpacity, ScrollView, StyleSheet, Platform } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { Text } from '@oxyhq/bloom/typography';
import * as Haptics from 'expo-haptics';
import {
  PinIcon,
  Clock01Icon,
  Image01Icon,
  PlayCircle02Icon,
  MusicNote01Icon,
  Pdf01Icon,
  Xls01Icon,
  Ppt01Icon,
  Doc01Icon,
  FileZipIcon,
  File01Icon,
} from '@hugeicons/core-free-icons';
import { Chip } from '@oxyhq/bloom/chip';
import { Badge } from '@oxyhq/bloom/badge';
import { Avatar } from './Avatar';
import { AttachmentThumbnail } from './AttachmentThumbnail';
import { ImportanceBadge } from './ImportanceBadge';
import { SentimentIndicator } from './SentimentIndicator';
import type { SentimentResult } from '@/hooks/queries/useSentimentAnalysis';
import { CardPreview } from './cards/CardPreview';
import { useColors } from '@/constants/theme';
import { SPACING as BLOOM_SPACING } from '@oxyhq/bloom/design-tokens';
import { SPACING, AVATAR_SIZE, RADIUS, TIMESTAMP_WIDTH } from '@/constants/layout';
import { useInboxDisplayPrefs } from '@/hooks/useInboxDisplayPrefs';
import { useEmailStore } from '@/hooks/useEmail';
import { emailKeys } from '@/hooks/queries/queryKeys';
import type { Message, Attachment } from '@/services/emailApi';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.oxy.so';

/**
 * Row timestamp, scaled to how far back the message is: the closer it is, the
 * more precise the label. Today only needs a time; last week only needs a
 * weekday; older than that needs the date.
 *
 *   today      → 3:33 PM
 *   yesterday  → Yesterday
 *   < 7 days   → Sat
 *   this year  → Jul 22
 *   older      → Jul 22, 24
 */
/**
 * Built once and reused. `toLocaleTimeString(undefined, {...})` constructs a
 * new `Intl.DateTimeFormat` on every call — the options path defeats the
 * engine's format cache — and a list mounts one row per message.
 */
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const WEEKDAY_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const MONTH_DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const MONTH_DAY_YEAR_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
const WEEKDAY_MONTH_DAY_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((today.getTime() - msgDay.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return TIME_FORMAT.format(date);
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return WEEKDAY_FORMAT.format(date);

  if (date.getFullYear() === now.getFullYear()) {
    return MONTH_DAY_FORMAT.format(date);
  }
  return MONTH_DAY_YEAR_FORMAT.format(date);
}

function getSenderName(message: Message): string {
  if (message.from.name) return message.from.name;
  return message.from.address.split('@')[0];
}

function getPreview(message: Message): string {
  const text = message.text || '';
  return text.replace(/\s+/g, ' ').trim().substring(0, 120);
}

type AttachmentInfo = {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  hugeIcon: IconSvgElement;
  label: string;
  color: string;
};

function getAttachmentInfo(att: Attachment): AttachmentInfo {
  const ct = att.contentType.toLowerCase();
  if (ct.startsWith('image/')) return { icon: 'image-outline', hugeIcon: Image01Icon as unknown as IconSvgElement, label: att.name, color: '#34A853' };
  if (ct.startsWith('video/')) return { icon: 'play-circle-outline', hugeIcon: PlayCircle02Icon as unknown as IconSvgElement, label: att.name, color: '#EA4335' };
  if (ct.startsWith('audio/')) return { icon: 'music-note-outline', hugeIcon: MusicNote01Icon as unknown as IconSvgElement, label: att.name, color: '#9334E6' };
  if (ct.includes('pdf')) return { icon: 'file-pdf-box', hugeIcon: Pdf01Icon as unknown as IconSvgElement, label: att.name, color: '#EA4335' };
  if (ct.includes('spreadsheet') || ct.includes('excel') || ct.includes('csv'))
    return { icon: 'file-excel-outline', hugeIcon: Xls01Icon as unknown as IconSvgElement, label: att.name, color: '#34A853' };
  if (ct.includes('presentation') || ct.includes('powerpoint'))
    return { icon: 'file-powerpoint-outline', hugeIcon: Ppt01Icon as unknown as IconSvgElement, label: att.name, color: '#E8710A' };
  if (ct.includes('document') || ct.includes('word') || ct.includes('msword'))
    return { icon: 'file-word-outline', hugeIcon: Doc01Icon as unknown as IconSvgElement, label: att.name, color: '#1A73E8' };
  if (ct.includes('zip') || ct.includes('rar') || ct.includes('tar') || ct.includes('gz'))
    return { icon: 'zip-box-outline', hugeIcon: FileZipIcon as unknown as IconSvgElement, label: att.name, color: '#5F6368' };
  return { icon: 'file-outline', hugeIcon: File01Icon as unknown as IconSvgElement, label: att.name, color: '#5F6368' };
}

function formatSnoozeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const snoozeDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((snoozeDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  const time = TIME_FORMAT.format(date);

  if (diffDays === 0) return `Today, ${time}`;
  if (diffDays === 1) return `Tomorrow, ${time}`;
  return `${WEEKDAY_MONTH_DAY_FORMAT.format(date)}, ${time}`;
}

interface MessageRowProps {
  message: Message;
  onPin?: (id: string) => void;
  onSelect: (id: string) => void;
  onArchive?: (id: string) => void;
  onDelete?: (id: string) => void;
  onToggleRead?: (id: string, seen: boolean) => void;
  isSelected?: boolean;
  isSelectionMode?: boolean;
  isMultiSelected?: boolean;
  onToggleSelect?: (id: string) => void;
  onLongPress?: (id: string) => void;
  isPinPending?: boolean;
  showSnoozeTime?: boolean;
}

function MessageRowInner({
  message,
  onPin,
  onSelect,
  onArchive,
  onDelete,
  onToggleRead,
  isSelected,
  isSelectionMode,
  isMultiSelected,
  onToggleSelect,
  onLongPress,
  isPinPending,
  showSnoozeTime,
}: MessageRowProps) {
  const colors = useColors();
  const { showAvatars, showPreviews } = useInboxDisplayPrefs();
  const isUnread = !message.flags.seen;
  const [rowHovered, setRowHovered] = useState(false);
  const queryClient = useQueryClient();
  const { user } = useOxy();
  const userId = user?.id ?? null;
  const api = useEmailStore((s) => s._api);
  const prefetchedRef = useRef(false);

  const showCheckbox = isSelectionMode || (Platform.OS === 'web' && rowHovered);
  const showRowActions = Platform.OS === 'web' && rowHovered && !isSelectionMode;

  const handlePress = useCallback(() => {
    if (isSelectionMode && onToggleSelect) {
      onToggleSelect(message._id);
    } else {
      onSelect(message._id);
    }
  }, [message._id, onSelect, onToggleSelect, isSelectionMode]);

  const handleLongPress = useCallback(() => {
    if (Platform.OS !== 'web' && onLongPress) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      onLongPress(message._id);
    }
  }, [message._id, onLongPress]);

  const handleCheckboxPress = useCallback(() => {
    if (onToggleSelect) {
      onToggleSelect(message._id);
    }
  }, [message._id, onToggleSelect]);

  const handlePin = useCallback(() => {
    onPin?.(message._id);
  }, [onPin, message._id]);

  const handleArchive = useCallback(() => {
    onArchive?.(message._id);
  }, [onArchive, message._id]);

  const handleDelete = useCallback(() => {
    onDelete?.(message._id);
  }, [onDelete, message._id]);

  const handleToggleRead = useCallback(() => {
    onToggleRead?.(message._id, !message.flags.seen);
  }, [onToggleRead, message._id, message.flags.seen]);

  // Prefetch message data on hover (web only, once per mount)
  const handleMouseEnter = useCallback(() => {
    if (!prefetchedRef.current && userId && api) {
      prefetchedRef.current = true;
      queryClient.prefetchQuery({
        queryKey: emailKeys.message.detail(message._id, userId),
        queryFn: async () => api.getMessage(message._id),
        staleTime: 60_000,
      });
    }
  }, [queryClient, message._id, userId, api]);

  const senderName = getSenderName(message);
  const preview = getPreview(message);
  const dateStr = formatDate(message.date);

  // Unread is carried by the row background alone: a tinted row reads at a
  // glance across a whole list, which a 6dp dot does not, and it keeps the
  // leading edge free of decoration.
  const rowBg = isMultiSelected || isSelected
    ? colors.selectedRow
    : isUnread
      ? colors.surface
      : 'transparent';

  // Only built when it is about to be shown. These are a web hover affordance,
  // so on native — and for every row the pointer is not over — the whole list
  // would otherwise be allocated and thrown away unread, once per render.
  const rowActions: { key: string; icon: keyof typeof MaterialCommunityIcons.glyphMap; label: string; onPress: () => void; active?: boolean }[] = [];
  if (showRowActions) {
    if (onArchive) rowActions.push({ key: 'archive', icon: 'archive-arrow-down-outline', label: 'Archive', onPress: handleArchive });
    if (onDelete) rowActions.push({ key: 'trash', icon: 'delete-outline', label: 'Move to Trash', onPress: handleDelete });
    if (onToggleRead) {
      rowActions.push({
        key: 'read',
        icon: isUnread ? 'email-open-outline' : 'email-outline',
        label: isUnread ? 'Mark as read' : 'Mark as unread',
        onPress: handleToggleRead,
      });
    }
    if (onPin) rowActions.push({ key: 'pin', icon: message.flags.pinned ? 'pin' : 'pin-outline', label: 'Pin thread', onPress: handlePin, active: message.flags.pinned });
  }

  return (
    <Pressable
      style={({ pressed }) => [
        styles.container,
        { backgroundColor: rowBg },
        rowHovered && !isMultiSelected && { backgroundColor: colors.surfaceVariant },
        pressed && { opacity: 0.7 },
      ]}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={500}
      {...(Platform.OS === 'web' ? ({
        onMouseEnter: () => {
          setRowHovered(true);
          handleMouseEnter();
        },
        onMouseLeave: () => setRowHovered(false),
      } as { onMouseEnter?: () => void; onMouseLeave?: () => void }) : {})}
    >
      {showAvatars && (
        <Pressable
          onPress={showCheckbox ? handleCheckboxPress : undefined}
          hitSlop={SPACING.xs}
          accessibilityRole={showCheckbox ? 'checkbox' : undefined}
          accessibilityState={showCheckbox ? { checked: Boolean(isMultiSelected) } : undefined}
          accessibilityLabel={showCheckbox ? 'Select' : undefined}
        >
          <Avatar
            name={senderName}
            size={AVATAR_SIZE}
            showCheckbox={showCheckbox}
            isChecked={isMultiSelected}
            avatarUrl={message.senderAvatarPath ? `${API_URL}${message.senderAvatarPath}` : null}
          />
        </Pressable>
      )}

      {/* Two stacked lines. The first one is a row that holds BOTH the sender
          and the trailing control (timestamp, snooze or the hover actions), so
          they share a baseline because they are siblings in the same flex row —
          not because their boxes were sized to match. The second is the
          summary, spanning the full width. */}
      <View style={styles.main}>
        <View style={styles.headline}>
          <Text style={[styles.sender, { color: colors.unread }]} numberOfLines={1}>
            {senderName}
          </Text>
          {(message.threadCount ?? 0) > 1 && (
            <Badge variant="subtle" color="default" content={message.threadCount!} size="small" />
          )}

          {showRowActions && rowActions.length > 0 ? (
            <View style={styles.trailing}>
              {rowActions.map((action) => (
                <TouchableOpacity
                  key={action.key}
                  onPress={action.onPress}
                  hitSlop={SPACING.md}
                  style={styles.rowActionButton}
                  accessibilityLabel={action.label}
                  disabled={action.key === 'pin' && isPinPending}
                >
                  <MaterialCommunityIcons
                    name={action.icon}
                    size={16}
                    color={action.active ? colors.primary : colors.icon}
                  />
                </TouchableOpacity>
              ))}
            </View>
          ) : showSnoozeTime && message.snoozedUntil ? (
            <View style={styles.trailing}>
              {Platform.OS === 'web' ? (
                <HugeiconsIcon icon={Clock01Icon as unknown as IconSvgElement} size={12} color={colors.primary} />
              ) : (
                <MaterialCommunityIcons name="clock-outline" size={12} color={colors.primary} />
              )}
              <Text style={[styles.snoozeTimeText, { color: colors.primary }]}>
                {formatSnoozeTime(message.snoozedUntil)}
              </Text>
            </View>
          ) : (
            <Text style={[styles.date, { color: colors.secondaryText }]} numberOfLines={1}>
              {dateStr}
            </Text>
          )}
        </View>

        <Text style={styles.summaryLine} numberOfLines={1}>
          <Text style={[styles.subject, { color: colors.unread }]}>
            {message.subject || '(no subject)'}
          </Text>
          {showPreviews && preview.length > 0 && (
            <Text style={[styles.snippet, { color: colors.secondaryText }]}>{`  ${preview}`}</Text>
          )}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * Everything a message can carry beyond the single line — labels, card
 * preview, attachment thumbnails. Rendered by the list under the row so the
 * row itself stays exactly one line tall.
 */
function MessageRowExtrasInner({ message, sentiment }: { message: Message; sentiment?: SentimentResult | null }) {
  const colors = useColors();
  const hasAttachments = message.attachments.length > 0;
  const hasChips = message.labels.length > 0 || Boolean(sentiment);

  if (!hasChips && !message.card && !hasAttachments) return null;

  return (
    <View style={styles.extras}>
        {/* Chip row: importance, sentiment and labels all live on this second
            line so the message line itself stays a single uninterrupted row. */}
        {hasChips && (
          <View style={styles.labelChipRow}>
            <ImportanceBadge message={message} />
            <SentimentIndicator sentiment={sentiment ?? null} size="small" />
            {message.labels.slice(0, 3).map((labelName) => {
              return (
                <Chip
                  key={labelName}
                  variant="soft"
                  size="small"
                >
                  {labelName}
                </Chip>
              );
            })}
            {message.labels.length > 3 && (
              <Text style={[styles.moreLabelText, { color: colors.secondaryText }]}>
                +{message.labels.length - 3}
              </Text>
            )}
          </View>
        )}

        {/* One horizontal rail of cards, Inbox-by-Gmail style: the extracted
            smart card (flight, order, event, bill, package) leads, then a card
            per attachment. Scrolls sideways instead of stacking rows, so a
            message with a flight and four files still costs one row of height. */}
        {(message.card || hasAttachments) && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.cardRail}
          >
            {message.card && (
              <View style={[styles.railCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <CardPreview card={message.card} />
              </View>
            )}

            {message.attachments.map((att, i) => {
              const isImage = att.contentType.toLowerCase().startsWith('image/');
              const info = getAttachmentInfo(att);
              return (
                <View
                  key={att.fileId || i}
                  style={[styles.railCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
                >
                  {isImage ? (
                    <AttachmentThumbnail fileId={att.fileId} size={40} />
                  ) : Platform.OS === 'web' ? (
                    <HugeiconsIcon icon={info.hugeIcon} size={20} color={info.color} />
                  ) : (
                    <MaterialCommunityIcons name={info.icon} size={20} color={info.color} />
                  )}
                  <Text style={[styles.railCardLabel, { color: colors.secondaryText }]} numberOfLines={1}>
                    {info.label}
                  </Text>
                </View>
              );
            })}
          </ScrollView>
        )}
    </View>
  );
}

export const MessageRow = React.memo(MessageRowInner, (prev, next) => {
  if (
    prev.isSelected !== next.isSelected ||
    prev.isMultiSelected !== next.isMultiSelected ||
    prev.isSelectionMode !== next.isSelectionMode ||
    prev.isPinPending !== next.isPinPending ||
    prev.showSnoozeTime !== next.showSnoozeTime
  ) {
    return false;
  }

  const pm = prev.message;
  const nm = next.message;
  return (
    pm._id === nm._id &&
    pm.flags.starred === nm.flags.starred &&
    pm.flags.seen === nm.flags.seen &&
    pm.flags.pinned === nm.flags.pinned &&
    pm.threadCount === nm.threadCount &&
    pm.subject === nm.subject &&
    pm.text === nm.text &&
    pm.date === nm.date &&
    pm.from.address === nm.from.address &&
    pm.from.name === nm.from.name &&
    pm.senderAvatarPath === nm.senderAvatarPath &&
    pm.snoozedUntil === nm.snoozedUntil &&
    (pm.labels?.length ?? 0) === (nm.labels?.length ?? 0) &&
    (pm.labels?.every((label, i) => label === nm.labels?.[i]) ?? true) &&
    (pm.attachments?.length ?? 0) === (nm.attachments?.length ?? 0) &&
    Boolean(pm.card) === Boolean(nm.card) &&
    pm.card?.type === nm.card?.type
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    // The avatar centres against the whole two-line block. The sender and the
    // timestamp align to each other inside `headline`, not here.
    alignItems: 'center',
    // Even inset on all four sides, at the vertical value.
    padding: SPACING.sm,
    gap: SPACING.sm,
    borderRadius: RADIUS.row,
  },
  main: {
    flex: 1,
    minWidth: 0,
    // Bloom's own spacing scale (the `--spacing-space-*` tokens) rather than a
    // local number, so the rhythm here matches every other Oxy surface.
    gap: BLOOM_SPACING['space-2'],
  },
  /**
   * First line: sender on the left, trailing control on the right. They are
   * siblings in one row, so the timestamp lines up with the name by
   * construction — no matched box heights, no offsets.
   */
  headline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  sender: {
    // Takes the slack in `headline`, pushing the trailing control to the edge.
    flex: 1,
    // Matches the notification title in Mention (`UserName`): 15/700, no
    // letter-spacing, so a row title reads the same across Oxy apps.
    fontSize: 15,
    fontWeight: '700',
  },
  summaryLine: {
    fontSize: 13,
    lineHeight: 18,
  },
  subject: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: -0.26,
  },
  snippet: {
    fontSize: 13,
    fontWeight: '400',
    letterSpacing: -0.26,
  },
  date: {
    flexShrink: 0,
    minWidth: TIMESTAMP_WIDTH,
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: -0.24,
    textAlign: 'right',
  },
  trailing: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  rowActionButton: {
    // `hitSlop` keeps the touch target comfortable without growing the box,
    // which would stretch the headline row it sits in.
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  snoozeTimeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  cardRail: {
    flexDirection: 'row',
    gap: SPACING.sm,
    paddingRight: SPACING.lg,
  },
  railCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    maxWidth: 220,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  railCardLabel: {
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '500',
  },
  extras: {
    paddingHorizontal: SPACING.sm,
    paddingBottom: SPACING.sm,
    gap: SPACING.sm,
  },
  labelChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  moreLabelText: {
    fontSize: 10,
  },
});

/**
 * Memoized for the same reason `MessageRow` is: it renders beside one for every
 * row, and the list re-renders mounted items on each selection toggle
 * (`extraData`). Without this, the row's comparator only halves the work.
 */
export const MessageRowExtras = React.memo(
  MessageRowExtrasInner,
  (prev, next) => prev.message === next.message && prev.sentiment?.type === next.sentiment?.type,
);
