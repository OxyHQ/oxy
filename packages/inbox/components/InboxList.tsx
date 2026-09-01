/**
 * Inbox message list with search bar, FAB compose, and pull-to-refresh.
 * Used by the (inbox) layout on desktop (always visible) and by the index route on mobile.
 */

import React, { useCallback, useMemo, useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  RefreshControl,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Loading } from '@oxyhq/bloom/loading';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { PencilEdit01Icon } from '@hugeicons/core-free-icons';
import { useRouter, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOxy, OxySignInButton } from '@oxyhq/services';
import { toast } from '@oxyhq/bloom';
import { useTabBarFootprint } from '@oxyhq/bloom/tab-bar';

import { useFloatingHeader } from '@/hooks/useFloatingHeader';
import { useColors } from '@/constants/theme';
import { SPACING, RADIUS, CONTENT_MAX_WIDTH } from '@/constants/layout';
import { SPECIAL_USE } from '@/constants/mailbox';
import { useEmailStore } from '@/hooks/useEmail';
import { useTabBarClearance } from '@/hooks/useTabBarClearance';
import { useInboxPrefs, type SwipeAction } from '@/contexts/inbox-prefs-context';
import { useInboxDisplayPrefs } from '@/hooks/useInboxDisplayPrefs';
import { useMessageActions } from '@/hooks/useMessageActions';
import { collapseThreads } from '@/utils/threadGrouping';
import { useMessages } from '@/hooks/queries/useMessages';
import { useMailboxes } from '@/hooks/queries/useMailboxes';
import { useLabels } from '@/hooks/queries/useLabels';
import {
  useToggleStar,
  useToggleRead,
  useTogglePin,
  useSnoozeMessage,
  useBulkUpdateFlags,
  useBulkMoveMessages,
} from '@/hooks/mutations/useMessageMutations';
import { MessageRow, MessageRowExtras } from '@/components/MessageRow';
import { InboxGreeting } from '@/components/InboxGreeting';
import { SearchHeader } from '@/components/SearchHeader';
import { SelectionToolbar } from '@/components/SelectionToolbar';
import { SwipeableRow } from '@/components/SwipeableRow';
import { SnoozeSheet } from '@/components/SnoozeSheet';
import { BundleRow } from '@/components/BundleRow';
import { ReminderRow } from '@/components/ReminderRow';
import { CreateReminderSheet } from '@/components/CreateReminderSheet';
import { EmptyIllustration } from '@/components/EmptyIllustration';
import { AliaChatSheet, type AliaChatSheetRef } from '@alia.onl/sdk';
import { AliaFace } from '@/components/AliaFace';
import { useBatchSentimentAnalysis } from '@/hooks/queries/useSentimentAnalysis';
import { useBundles } from '@/hooks/queries/useBundles';
import { useReminders } from '@/hooks/queries/useReminders';
import { useCreateReminder, useUpdateReminder, useDeleteReminder } from '@/hooks/mutations/useReminderMutations';
import type { Message, Bundle, Reminder } from '@/services/emailApi';

type ListItem =
  | { type: 'header'; title: string; key: string; count?: number }
  | { type: 'message'; data: Message }
  | { type: 'bundle'; bundle: Bundle; messages: Message[]; unreadCount: number }
  | { type: 'reminder'; data: Reminder };

/** Section title for a message: one card per calendar bucket. */
function getDateCategory(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((today.getTime() - msgDay.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return 'This Week';
  if (diffDays < 30) return 'This Month';
  return 'Earlier';
}

/**
 * Pushes a titled section: one list item holding the whole group, rendered as
 * a Bloom `SettingsListGroup` card with its title above it.
 *
 * The group is a single FlashList item, so its rows are not individually
 * virtualized — acceptable because a group spans one date bucket of one page,
 * and it is the price of framing each section with a shared card component
 * instead of hand-rolling per-row borders.
 */
function pushGroup(items: ListItem[], title: string, key: string, messages: Message[]): void {
  if (messages.length === 0) return;
  // One list item per message, not one per bucket. FlashList mounts an item
  // whole, so a bucket-sized item would mount every message in it — the
  // "Earlier" bucket spans page boundaries and reaches hundreds of rows. The
  // section reads as a group through its heading and the per-row spacing; it
  // never had a surface of its own to hold it together.
  if (title) items.push({ type: 'header', title, key, count: messages.length });
  for (const msg of messages) items.push({ type: 'message', data: msg });
}

/** Splits messages into consecutive date buckets, preserving list order. */
function groupByDate(messages: Message[]): { title: string; messages: Message[] }[] {
  const groups: { title: string; messages: Message[] }[] = [];
  for (const msg of messages) {
    const title = getDateCategory(msg.date);
    const current = groups[groups.length - 1];
    if (current && current.title === title) {
      current.messages.push(msg);
      continue;
    }
    groups.push({ title, messages: [msg] });
  }
  return groups;
}

interface InboxListProps {
  /** When true, uses router.replace for message navigation (desktop split-view) */
  replaceNavigation?: boolean;
}

interface DrawerNavigation {
  openDrawer?: () => void;
  dispatch?: (action: unknown) => void;
}

/**
 * Vertical offset (in dp) above the Compose FAB's own anchor for the Alia FAB,
 * so the two stack with at least 24pt of separation:
 *   Compose bottom = tab-bar footprint + 16, Compose height ≈ 52, plus 24 gap.
 */
const ALIA_FAB_BOTTOM_OFFSET = 16 + 52 + 24;
const ALIA_PROXY_API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.oxy.so';

export function InboxList({ replaceNavigation }: InboxListProps) {
  const router = useRouter();
  const navigation = useNavigation<DrawerNavigation>();
  const insets = useSafeAreaInsets();
  const tabBarFootprint = useTabBarFootprint();
  const tabBarClearance = useTabBarClearance();
  const colors = useColors();
  const aliaChatRef = useRef<AliaChatSheetRef>(null);
  const { isAuthenticated } = useOxy();
  const { prefs } = useInboxPrefs();
  const { conversationView } = useInboxDisplayPrefs();
  const messageActions = useMessageActions();

  const currentMailbox = useEmailStore((s) => s.currentMailbox);
  const viewMode = useEmailStore((s) => s.viewMode);
  const selectedMessageId = useEmailStore((s) => s.selectedMessageId);
  const isSelectionMode = useEmailStore((s) => s.isSelectionMode);
  const selectedMessageIds = useEmailStore((s) => s.selectedMessageIds);
  const toggleMessageSelection = useEmailStore((s) => s.toggleMessageSelection);
  const enterSelectionMode = useEmailStore((s) => s.enterSelectionMode);
  const clearSelection = useEmailStore((s) => s.clearSelection);

  const { data: mailboxes = [] } = useMailboxes();

  /**
   * Falls back to the Inbox when nothing has been selected yet.
   *
   * The route→store sync lives in `MailboxView`, which renders inside the
   * detail `<Slot/>`. On desktop that Slot is only mounted when a message is
   * open, so without this fallback the list would sit empty on first load —
   * `useMessages` is gated on `enabled: hasFilter`, and no mailbox id means no
   * request at all.
   */
  const inboxMailboxId = useMemo(
    () => mailboxes.find((m) => m.specialUse === SPECIAL_USE.INBOX)?._id,
    [mailboxes],
  );

  const messagesOptions = useMemo(() => {
    if (!viewMode) return { mailboxId: currentMailbox?._id ?? inboxMailboxId };
    switch (viewMode.type) {
      case 'mailbox':
        return { mailboxId: viewMode.mailbox._id };
      case 'starred':
        return { starred: true };
      case 'label':
        return { label: viewMode.labelName };
    }
  }, [viewMode, currentMailbox, inboxMailboxId]);

  const {
    data,
    isLoading,
    isRefetching,
    isFetchingNextPage,
    refetch,
    fetchNextPage,
    hasNextPage,
  } = useMessages(messagesOptions);
  const { data: labels = [] } = useLabels();
  const labelColorMap = useMemo(() => {
    const map = new Map<string, string>();
    labels.forEach((l) => map.set(l.name, l.color));
    return map;
  }, [labels]);
  const bundleView = useEmailStore((s) => s.bundleView);
  const expandedBundles = useEmailStore((s) => s.expandedBundles);
  const toggleBundle = useEmailStore((s) => s.toggleBundle);

  const toggleStar = useToggleStar();
  const toggleRead = useToggleRead();
  const togglePin = useTogglePin();
  const snoozeMutation = useSnoozeMessage();
  const bulkFlags = useBulkUpdateFlags();
  const bulkMove = useBulkMoveMessages();
  const { data: bundles = [] } = useBundles();

  const { headerHeight, onHeaderLayout, floatingHeaderStyle } = useFloatingHeader();
  const [snoozeTargetId, setSnoozeTargetId] = useState<string | null>(null);
  const [createReminderVisible, setCreateReminderVisible] = useState(false);
  const [editReminderTarget, setEditReminderTarget] = useState<Reminder | null>(null);

  const { data: remindersResult } = useReminders();
  const reminders = useMemo(() => remindersResult?.data ?? [], [remindersResult]);
  const createReminderMutation = useCreateReminder();
  const updateReminderMutation = useUpdateReminder();
  const deleteReminderMutation = useDeleteReminder();

  const messages = useMemo(() => data?.pages.flatMap((p) => p.data) ?? [], [data]);

  // Thread grouping is a post-process over the fetched list (single query, no
  // duplicate list): collapse to one row per conversation when the pref is on.
  const displayMessages = useMemo(
    () => (conversationView ? collapseThreads(messages) : messages),
    [messages, conversationView],
  );

  // Batch sentiment analysis — computed once for all messages, passed as props to rows
  const sentimentMap = useBatchSentimentAnalysis(displayMessages);

  const isInboxView = viewMode?.type === 'mailbox' && viewMode.mailbox.specialUse === SPECIAL_USE.INBOX;
  const isSnoozedView = viewMode?.type === 'mailbox' && viewMode.mailbox.specialUse === SPECIAL_USE.SNOOZED;
  const showBundles = bundleView && isInboxView && bundles.length > 0;

  const listItems = useMemo<ListItem[]>(() => {
    if (displayMessages.length === 0 && reminders.length === 0) return [];
    const items: ListItem[] = [];

    // Due/active reminders at the top (only in inbox view)
    if (isInboxView && reminders.length > 0) {
      const dueReminders = reminders.filter(
        (r) => !r.completed && new Date(r.remindAt) <= new Date(),
      );
      const upcomingReminders = reminders.filter(
        (r) => !r.completed && new Date(r.remindAt) > new Date(),
      );

      if (dueReminders.length > 0) {
        items.push({ type: 'header', title: 'Reminders', key: 'header-Reminders' });
        for (const r of dueReminders) {
          items.push({ type: 'reminder', data: r });
        }
      }
      if (upcomingReminders.length > 0 && upcomingReminders.length <= 3) {
        if (dueReminders.length === 0) {
          items.push({ type: 'header', title: 'Reminders', key: 'header-Reminders' });
        }
        for (const r of upcomingReminders) {
          items.push({ type: 'reminder', data: r });
        }
      }
    }

    // Partition pinned messages to top (only in mailbox views, not snoozed)
    const pinned = !isSnoozedView ? displayMessages.filter((m) => m.flags.pinned) : [];
    const unpinned = !isSnoozedView ? displayMessages.filter((m) => !m.flags.pinned) : displayMessages;

    pushGroup(items, 'Pinned', 'header-Pinned', pinned);

    // Bundle view: group by bundle labels
    if (showBundles) {
      const enabledBundles = bundles.filter((b) => b.enabled);
      const bundledLabels = new Set<string>();
      for (const b of enabledBundles) {
        for (const l of b.matchLabels) bundledLabels.add(l);
      }

      const primaryMsgs: Message[] = [];
      const bundleMap = new Map<string, Message[]>();
      for (const b of enabledBundles) bundleMap.set(b._id, []);

      for (const msg of unpinned) {
        let matched = false;
        for (const b of enabledBundles) {
          if (b.matchLabels.some((l) => msg.labels.includes(l))) {
            const bucket = bundleMap.get(b._id);
            if (bucket) {
              bucket.push(msg);
              matched = true;
              break;
            }
          }
        }
        if (!matched) primaryMsgs.push(msg);
      }

      for (const group of groupByDate(primaryMsgs)) {
        pushGroup(items, group.title, `header-${group.title}`, group.messages);
      }

      // Bundle rows (collapsed or expanded)
      for (const b of enabledBundles) {
        const msgs = bundleMap.get(b._id) || [];
        if (msgs.length === 0) continue;
        const unreadCount = msgs.filter((m) => !m.flags.seen).length;
        items.push({ type: 'bundle', bundle: b, messages: msgs, unreadCount });

        if (expandedBundles.has(b._id)) {
          for (const msg of msgs) items.push({ type: 'message', data: msg });
        }
      }
    } else {
      for (const group of groupByDate(unpinned)) {
        pushGroup(items, group.title, `header-${group.title}`, group.messages);
      }
    }

    return items;
  }, [displayMessages, isSnoozedView, isInboxView, showBundles, bundles, expandedBundles, reminders]);

  // Clear selection when view changes
  useEffect(() => {
    clearSelection();
  }, [viewMode, clearSelection]);

  const handleRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  const handleLoadMore = useCallback(() => {
    if (isFetchingNextPage || !hasNextPage) return;
    fetchNextPage();
  }, [fetchNextPage, isFetchingNextPage, hasNextPage]);

  const handleStar = useCallback(
    (messageId: string) => {
      if (toggleStar.isPending) return;
      const msg = messages.find((m) => m._id === messageId);
      if (msg) toggleStar.mutate({ messageId, starred: !msg.flags.starred });
    },
    [messages, toggleStar],
  );

  const handlePin = useCallback(
    (messageId: string) => {
      if (togglePin.isPending) return;
      const msg = messages.find((m) => m._id === messageId);
      if (msg) togglePin.mutate({ messageId, pinned: !msg.flags.pinned });
    },
    [messages, togglePin],
  );

  const handleToggleRead = useCallback(
    (messageId: string, seen: boolean) => {
      toggleRead.mutate({ messageId, seen });
    },
    [toggleRead],
  );

  const handleSnooze = useCallback(
    (until: Date) => {
      if (!snoozeTargetId) return;
      snoozeMutation.mutate({ messageId: snoozeTargetId, until: until.toISOString() });
      setSnoozeTargetId(null);
    },
    [snoozeTargetId, snoozeMutation],
  );

  const handleCreateReminder = useCallback(
    (text: string, remindAt: Date) => {
      createReminderMutation.mutate({ text, remindAt: remindAt.toISOString() });
      setCreateReminderVisible(false);
    },
    [createReminderMutation],
  );

  const handleToggleReminderComplete = useCallback(
    (reminderId: string, completed: boolean) => {
      updateReminderMutation.mutate({ reminderId, completed });
    },
    [updateReminderMutation],
  );

  const handleDeleteReminder = useCallback(
    (reminderId: string) => {
      deleteReminderMutation.mutate(reminderId);
    },
    [deleteReminderMutation],
  );

  const handleReminderPress = useCallback(
    (reminderId: string) => {
      const reminder = reminders.find((r) => r._id === reminderId);
      if (!reminder) return;
      // Reminders created from an email open that conversation; standalone
      // reminders open the edit sheet to reschedule / edit text.
      if (reminder.relatedMessageId) {
        if (replaceNavigation) {
          router.replace(`/conversation/${reminder.relatedMessageId}`);
        } else {
          router.push(`/conversation/${reminder.relatedMessageId}`);
        }
        return;
      }
      setEditReminderTarget(reminder);
    },
    [reminders, router, replaceNavigation],
  );

  const handleUpdateReminder = useCallback(
    (text: string, remindAt: Date) => {
      if (!editReminderTarget) return;
      updateReminderMutation.mutate({
        reminderId: editReminderTarget._id,
        text,
        remindAt: remindAt.toISOString(),
      });
      setEditReminderTarget(null);
    },
    [editReminderTarget, updateReminderMutation],
  );

  const handleMessagePress = useCallback(
    (messageId: string) => {
      messageActions.prepareOpenMessage(messageId);
      if (replaceNavigation) {
        router.replace(`/conversation/${messageId}`);
      } else {
        router.push(`/conversation/${messageId}`);
      }
    },
    [router, replaceNavigation, messageActions],
  );

  const handleOpenDrawer = useCallback(() => {
    // Synthesize the DrawerActions.openDrawer payload inline — expo-router v56
    // rejects direct `@react-navigation/*` imports.
    if (navigation.openDrawer) {
      navigation.openDrawer();
      return;
    }
    navigation.dispatch?.({ type: 'OPEN_DRAWER' });
  }, [navigation]);

  const handleCompose = useCallback(() => {
    if (replaceNavigation) {
      router.replace('/compose');
    } else {
      router.push('/compose');
    }
  }, [router, replaceNavigation]);

  const handleSearch = useCallback(() => {
    router.push('/search');
  }, [router]);

  const handleLongPress = useCallback(
    (id: string) => {
      enterSelectionMode(id);
    },
    [enterSelectionMode],
  );

  // Bulk actions — single API call per operation
  const handleBulkArchive = useCallback(() => {
    const archiveBox = mailboxes.find((m) => m.specialUse === SPECIAL_USE.ARCHIVE);
    if (!archiveBox) {
      toast.error('Archive folder not available.');
      return;
    }
    bulkMove.mutate({ messageIds: [...selectedMessageIds], mailboxId: archiveBox._id });
    clearSelection();
  }, [selectedMessageIds, mailboxes, bulkMove, clearSelection]);

  const handleBulkDelete = useCallback(() => {
    const trashBox = mailboxes.find((m) => m.specialUse === SPECIAL_USE.TRASH);
    if (!trashBox) {
      toast.error('Trash folder not available.');
      return;
    }
    bulkMove.mutate({ messageIds: [...selectedMessageIds], mailboxId: trashBox._id });
    clearSelection();
  }, [selectedMessageIds, mailboxes, bulkMove, clearSelection]);

  const handleBulkStar = useCallback(() => {
    const selected = messages.filter((m) => selectedMessageIds.has(m._id));
    const shouldStar = selected.some((m) => !m.flags.starred);
    bulkFlags.mutate({ messageIds: [...selectedMessageIds], flags: { starred: shouldStar } });
    clearSelection();
  }, [selectedMessageIds, messages, bulkFlags, clearSelection]);

  const handleBulkMarkRead = useCallback(() => {
    const selected = messages.filter((m) => selectedMessageIds.has(m._id));
    const shouldMarkRead = selected.some((m) => !m.flags.seen);
    bulkFlags.mutate({ messageIds: [...selectedMessageIds], flags: { seen: shouldMarkRead } });
    clearSelection();
  }, [selectedMessageIds, messages, bulkFlags, clearSelection]);

  // Derive title from view mode
  const mailboxTitle = useMemo(() => {
    if (viewMode?.type === 'starred') return 'Starred';
    if (viewMode?.type === 'label') return viewMode.labelName;
    if (currentMailbox?.specialUse) return currentMailbox.specialUse.replace(/^\\+/, '');
    return currentMailbox?.name || 'Inbox';
  }, [viewMode, currentMailbox]);

  // Single entry point for swipe actions. `SwipeableRow` only knows which
  // action the user configured; the behaviour lives here via `useMessageActions`.
  const handleSwipeAction = useCallback(
    (action: SwipeAction, messageId: string) => {
      switch (action) {
        case 'archive':
          messageActions.archive(messageId);
          break;
        case 'delete':
          messageActions.deleteMessage(messageId);
          break;
        case 'mark-read':
          messageActions.markAsRead(messageId);
          break;
        case 'snooze':
          setSnoozeTargetId(messageId);
          break;
        case 'none':
          break;
      }
    },
    [messageActions],
  );

  /** One message row, shared by the flat items and the grouped panels. */
  const renderMessageRow = useCallback(
    (msg: Message) => (
      <SwipeableRow
        key={msg._id}
        messageId={msg._id}
        leftAction={prefs.leftSwipeAction}
        rightAction={prefs.rightSwipeAction}
        onAction={handleSwipeAction}
      >
        <MessageRow
          message={msg}
          onPin={handlePin}
          onSelect={handleMessagePress}
          onArchive={messageActions.archive}
          onDelete={messageActions.deleteMessage}
          onToggleRead={handleToggleRead}
          isSelected={msg._id === selectedMessageId}
          isSelectionMode={isSelectionMode}
          isMultiSelected={selectedMessageIds.has(msg._id)}
          onToggleSelect={toggleMessageSelection}
          onLongPress={handleLongPress}
          isPinPending={togglePin.isPending && togglePin.variables?.messageId === msg._id}
          showSnoozeTime={isSnoozedView}
        />
        <MessageRowExtras message={msg} sentiment={sentimentMap.get(msg._id)} />
      </SwipeableRow>
    ),
    [prefs.leftSwipeAction, prefs.rightSwipeAction, handleSwipeAction, handlePin, handleMessagePress, messageActions, handleToggleRead, selectedMessageId, isSelectionMode, selectedMessageIds, toggleMessageSelection, handleLongPress, togglePin.isPending, togglePin.variables?.messageId, isSnoozedView, sentimentMap],
  );

  const renderItem = useCallback(
    ({ item }: { item: ListItem }) => {
      if (item.type === 'header') {
        return (
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionHeaderText, { color: colors.secondaryText }]}>
              {item.title}
            </Text>
            {item.count !== undefined ? (
              <Text style={[styles.sectionHeaderCount, { color: colors.secondaryText }]}>
                {item.count}
              </Text>
            ) : null}
          </View>
        );
      }
      if (item.type === 'bundle') {
        return (
          <BundleRow
            bundle={item.bundle}
            messages={item.messages}
            unreadCount={item.unreadCount}
            isExpanded={expandedBundles.has(item.bundle._id)}
            onToggle={() => toggleBundle(item.bundle._id)}
          />
        );
      }
      if (item.type === 'reminder') {
        return (
          <ReminderRow
            reminder={item.data}
            onToggleComplete={handleToggleReminderComplete}
            onPress={handleReminderPress}
            onDelete={handleDeleteReminder}
          />
        );
      }
      return <View style={styles.messageItem}>{renderMessageRow(item.data)}</View>;
    },
    // Only what this function itself reads. It used to re-list
    // `renderMessageRow`'s own dependencies by hand while omitting
    // `renderMessageRow` — so the copy had to be kept in sync manually, and
    // every row kept whichever callbacks it closed over when the copy last
    // happened to change.
    [renderMessageRow, expandedBundles, toggleBundle, handleToggleReminderComplete, handleDeleteReminder, handleReminderPress, colors.secondaryText],
  );

  const getItemType = useCallback((item: ListItem) => item.type, []);

  const keyExtractor = useCallback((item: ListItem) => {
    if (item.type === 'header') return item.key;
    if (item.type === 'bundle') return `bundle-${item.bundle._id}`;
    if (item.type === 'reminder') return `reminder-${item.data._id}`;
    return item.data._id;
  }, []);

  const renderEmpty = useCallback(() => {
    if (isLoading) return null;
    return (
      <View style={styles.emptyContainer}>
        <EmptyIllustration size={180} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>Nothing here</Text>
        <Text style={[styles.emptySubtitle, { color: colors.secondaryText }]}>
          {isAuthenticated
            ? "You're all caught up."
            : 'Sign in to access your mail.'}
        </Text>
        {!isAuthenticated && (
          <OxySignInButton variant="contained" style={{ marginTop: 8 }} />
        )}
      </View>
    );
  }, [isLoading, colors, isAuthenticated]);

  const renderFooter = useCallback(() => {
    if (!isFetchingNextPage) return null;
    return (
      <View style={styles.footer}>
        <Loading variant="inline" size="small" />
      </View>
    );
  }, [isFetchingNextPage]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {isSelectionMode ? (
        <SelectionToolbar
          count={selectedMessageIds.size}
          onClose={clearSelection}
          onArchive={handleBulkArchive}
          onDelete={handleBulkDelete}
          onStar={handleBulkStar}
          onMarkRead={handleBulkMarkRead}
        />
      ) : (
        // Floats above the list so rows scroll behind its gradient. Its
        // measured height becomes the list's top padding, so the first row
        // still starts below it instead of under it.
        <View style={floatingHeaderStyle} onLayout={onHeaderLayout}
        >
          <SearchHeader
            onLeftIcon={handleOpenDrawer}
            leftIcon="menu"
            placeholder={`Search in ${mailboxTitle.toLowerCase()}`}
            onPress={handleSearch}
          />
        </View>
      )}

      {isLoading && messages.length === 0 ? (
        <View style={styles.loadingContainer}>
          <Loading />
        </View>
      ) : (
        <View style={styles.listContainer}>
          <FlashList
            data={listItems}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            ListHeaderComponent={<InboxGreeting messages={messages} />}
            ListEmptyComponent={renderEmpty}
            ListFooterComponent={renderFooter}
            onEndReached={handleLoadMore}
            onEndReachedThreshold={0.3}
            extraData={selectedMessageIds}
            refreshControl={
              <RefreshControl
                refreshing={isRefetching && !isFetchingNextPage}
                onRefresh={handleRefresh}
                tintColor={colors.primary}
                colors={[colors.primary]}
              />
            }
            contentContainerStyle={{
              ...(listItems.length === 0 ? styles.emptyListContent : null),
              ...styles.listContent,
              paddingTop: headerHeight,
              paddingBottom: tabBarClearance,
            }}
            showsVerticalScrollIndicator={false}
          />
        </View>
      )}

      {isAuthenticated && !isSelectionMode && (
        <TouchableOpacity
          accessibilityLabel="Compose new email"
          accessibilityRole="button"
          style={[
            styles.fab,
            {
              backgroundColor: colors.composeFab,
              // Anchored on the floating bar's own footprint, which already has
              // the bottom safe-area inset folded into it — so this is uniform
              // across platforms, where the old NativeTabs anchor had to special-
              // case Android (its tab content sat in a bottom-edge SafeAreaView
              // that applied the inset a second time).
              bottom: tabBarFootprint + 16,
              right: insets.right + 16,
            },
            Platform.select({
              ios: {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.2,
                shadowRadius: 8,
              },
              android: { elevation: 6 },
              web: { boxShadow: '0 2px 10px rgba(0,0,0,0.2)' },
            }),
          ]}
          onPress={handleCompose}
          activeOpacity={0.8}
        >
          {Platform.OS === 'web' ? (
            <HugeiconsIcon icon={PencilEdit01Icon as unknown as IconSvgElement} size={24} color={colors.composeFabIcon} />
          ) : (
            <MaterialCommunityIcons name="pencil" size={24} color={colors.composeFabIcon} />
          )}
          {Platform.OS === 'web' && (
            <Text style={[styles.fabLabel, { color: colors.composeFabText }]}>Compose</Text>
          )}
        </TouchableOpacity>
      )}

      {/* Alia AI chat assistant */}
      {isAuthenticated && !isSelectionMode && (
        <>
          <View
            style={[
              styles.aliaFab,
              {
                // Mirrors the Compose FAB's anchor, one stack step higher.
                bottom: tabBarFootprint + ALIA_FAB_BOTTOM_OFFSET,
                right: insets.right + 16,
              },
            ]}
          >
            <TouchableOpacity
              accessibilityLabel="Ask Alia"
              accessibilityRole="button"
              accessibilityHint="Opens the Alia AI assistant to ask questions about your inbox"
              style={styles.aliaFabTouchable}
              onPress={() => aliaChatRef.current?.present()}
              activeOpacity={0.8}
            >
              <AliaFace size={52} expression="Idle A" />
            </TouchableOpacity>
          </View>
          <AliaChatSheet
            ref={aliaChatRef}
            apiUrl={ALIA_PROXY_API_URL}
            clientContext="User is in the Inbox app viewing their email. Use oxy_inbox tools to access their emails."
            // AliaChatSheet's welcome suggestions are {id, title, description}; per-item icons are no longer supported upstream.
            welcomeSuggestions={[
              { id: 'unread', title: 'Unread emails', description: 'What emails need my attention?' },
              { id: 'today-summary', title: "Today's summary", description: 'Summarize my emails from today' },
              { id: 'with-attachments', title: 'With attachments', description: 'Find emails with attachments' },
            ]}
          />
        </>
      )}

      {/* Snooze sheet */}
      <SnoozeSheet
        visible={snoozeTargetId !== null}
        onClose={() => setSnoozeTargetId(null)}
        onSnooze={handleSnooze}
      />

      {/* Create reminder sheet */}
      <CreateReminderSheet
        visible={createReminderVisible}
        onClose={() => setCreateReminderVisible(false)}
        onCreate={handleCreateReminder}
      />

      {/* Edit reminder sheet (opened by tapping a standalone reminder) */}
      <CreateReminderSheet
        visible={editReminderTarget !== null}
        editReminder={editReminderTarget}
        onClose={() => setEditReminderTarget(null)}
        onCreate={handleCreateReminder}
        onUpdate={handleUpdateReminder}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
  },
  listContent: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  listContainer: {
    flex: 1,
    minHeight: 0,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 120,
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: 'center',
  },
  emptyListContent: {
    flexGrow: 1,
  },
  footer: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  fab: {
    position: 'absolute',
    // `right` is set inline so it can include `insets.right` for landscape
    // notch protection (see JSX).
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 20,
    gap: 10,
  },
  fabLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  messageItem: {
    marginHorizontal: SPACING.md,
    // Small gap between messages instead of divider lines. A margin rather
    // than a parent `gap`, now that each row is its own list item.
    marginBottom: SPACING.xs,
  },
  sectionHeader: {
    // Sits above its rows, outside them — hence no border of its own. The count
    // rides here rather than in a global toolbar, so it describes the section
    // it labels. `marginHorizontal` matches `messageItem` so the heading keeps
    // the same left edge as the rows it labels, which it used to inherit from
    // the group wrapper.
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: SPACING.xs,
    marginHorizontal: SPACING.md,
    paddingHorizontal: SPACING.xs,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.sm,
  },
  sectionHeaderCount: {
    fontSize: 11,
    fontWeight: '500',
    opacity: 0.7,
  },
  sectionHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  aliaFab: {
    position: 'absolute',
    // `right` is set inline so it can include `insets.right` for landscape
    // notch protection (see JSX).
    zIndex: 100,
    ...Platform.select({
      web: { boxShadow: '0 4px 16px rgba(0,0,0,0.2)' },
      default: { elevation: 8 },
    }),
    borderRadius: 28,
  },
  aliaFabTouchable: {
    borderRadius: 28,
  },
});
