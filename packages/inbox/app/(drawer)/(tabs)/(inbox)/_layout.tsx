/**
 * Responsive inbox layout.
 *
 * Desktop (web ≥ 900px): two-column split — InboxList on left, Slot (child route) on right.
 * Mobile / narrow: Stack navigation — index shows list, conversation/[id] pushes on top.
 */

import React, { useMemo, useCallback } from 'react';
import { View, TouchableOpacity, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Slot, Stack, useRouter, usePathname } from 'expo-router';
import { useDialogControl } from '@oxyhq/bloom';
import { ContentPanel } from '@oxyhq/bloom/content-panel';

import { useColors } from '@/constants/theme';
import { SPACING, RADIUS } from '@/constants/layout';
import { SPECIAL_USE } from '@/constants/mailbox';
import { InboxList } from '@/components/InboxList';
import { KeyboardShortcutsHelp } from '@/components/KeyboardShortcutsHelp';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useEmailStore } from '@/hooks/useEmail';
import { useMessages } from '@/hooks/queries/useMessages';
import { useMailboxes } from '@/hooks/queries/useMailboxes';
import { useToggleStar, useToggleRead, useArchiveMessage, useDeleteMessage } from '@/hooks/mutations/useMessageMutations';

export default function InboxLayout() {
  const { width } = useWindowDimensions();
  const router = useRouter();
  const pathname = usePathname();
  const colors = useColors();
  const isDesktop = Platform.OS === 'web' && width >= 900;
  /**
   * Every child of this group is either a mailbox list (`/`, `/sent`,
   * `/label/x` — they render an empty state into the Slot) or a detail ABOUT a
   * message (`conversation`, `compose`), which sits beside the list.
   *
   * Screens that are neither do not belong in this navigator at all: they get
   * their own route outside the group, so they are never squeezed into the
   * detail slot. `subscriptions` used to live here and rendered invisible on
   * desktop for exactly that reason.
   */
  const hasOpenDetail = pathname.startsWith('/conversation/') || pathname.startsWith('/compose');

  const currentMailbox = useEmailStore((s) => s.currentMailbox);
  const selectedMessageId = useEmailStore((s) => s.selectedMessageId);

  const { data: mailboxes = [] } = useMailboxes();
  const { data: messagesData } = useMessages({
    mailboxId: currentMailbox?._id,
  });
  const messages = useMemo(() => messagesData?.pages.flatMap((p) => p.data) ?? [], [messagesData]);

  const toggleStar = useToggleStar();
  const toggleRead = useToggleRead();
  const archiveMutation = useArchiveMessage();
  const deleteMutation = useDeleteMessage();

  const currentIndex = useMemo(() => {
    if (!selectedMessageId) return -1;
    return messages.findIndex((m) => m._id === selectedMessageId);
  }, [selectedMessageId, messages]);

  const currentMessage = useMemo(() => {
    if (currentIndex === -1) return null;
    return messages[currentIndex] ?? null;
  }, [currentIndex, messages]);

  const handleCompose = useCallback(() => {
    if (isDesktop) {
      router.replace('/compose');
    } else {
      router.push('/compose');
    }
  }, [router, isDesktop]);

  const handleReply = useCallback(() => {
    if (selectedMessageId && currentMessage) {
      if (isDesktop) {
        router.replace({
          pathname: '/compose',
          params: {
            replyTo: currentMessage._id,
            to: currentMessage.from.address,
            subject: currentMessage.subject.startsWith('Re:')
              ? currentMessage.subject
              : `Re: ${currentMessage.subject}`,
          },
        });
      }
    }
  }, [selectedMessageId, currentMessage, router, isDesktop]);

  const handleReplyAll = useCallback(() => {
    if (selectedMessageId && currentMessage) {
      const allTo = [currentMessage.from, ...(currentMessage.to || [])];
      const allCc = currentMessage.cc || [];
      if (isDesktop) {
        router.replace({
          pathname: '/compose',
          params: {
            replyTo: currentMessage._id,
            to: allTo.map((a) => a.address).join(','),
            cc: allCc.map((a) => a.address).join(','),
            subject: currentMessage.subject.startsWith('Re:')
              ? currentMessage.subject
              : `Re: ${currentMessage.subject}`,
          },
        });
      }
    }
  }, [selectedMessageId, currentMessage, router, isDesktop]);

  const handleForward = useCallback(() => {
    if (selectedMessageId && currentMessage) {
      if (isDesktop) {
        router.replace({
          pathname: '/compose',
          params: {
            forward: currentMessage._id,
            subject: currentMessage.subject.startsWith('Fwd:')
              ? currentMessage.subject
              : `Fwd: ${currentMessage.subject}`,
          },
        });
      }
    }
  }, [selectedMessageId, currentMessage, router, isDesktop]);

  const handleArchive = useCallback(() => {
    if (selectedMessageId) {
      const archiveBox = mailboxes.find((m) => m.specialUse === SPECIAL_USE.ARCHIVE);
      if (archiveBox) {
        archiveMutation.mutate({ messageId: selectedMessageId, archiveMailboxId: archiveBox._id });
      }
    }
  }, [selectedMessageId, mailboxes, archiveMutation]);

  const handleDelete = useCallback(() => {
    if (selectedMessageId) {
      const trashBox = mailboxes.find((m) => m.specialUse === SPECIAL_USE.TRASH);
      const isInTrash = currentMailbox?.specialUse === SPECIAL_USE.TRASH;
      deleteMutation.mutate({ messageId: selectedMessageId, trashMailboxId: trashBox?._id, isInTrash });
    }
  }, [selectedMessageId, mailboxes, currentMailbox, deleteMutation]);

  const handleNextMessage = useCallback(() => {
    if (currentIndex < messages.length - 1) {
      const nextMessage = messages[currentIndex + 1];
      useEmailStore.setState({ selectedMessageId: nextMessage._id });
      if (isDesktop) {
        router.replace(`/conversation/${nextMessage._id}`);
      }
    }
  }, [currentIndex, messages, router, isDesktop]);

  const handlePrevMessage = useCallback(() => {
    if (currentIndex > 0) {
      const prevMessage = messages[currentIndex - 1];
      useEmailStore.setState({ selectedMessageId: prevMessage._id });
      if (isDesktop) {
        router.replace(`/conversation/${prevMessage._id}`);
      }
    }
  }, [currentIndex, messages, router, isDesktop]);

  const handleToggleStar = useCallback(() => {
    if (selectedMessageId && currentMessage) {
      toggleStar.mutate({ messageId: selectedMessageId, starred: !currentMessage.flags.starred });
    }
  }, [selectedMessageId, currentMessage, toggleStar]);

  const handleMarkUnread = useCallback(() => {
    if (selectedMessageId) {
      toggleRead.mutate({ messageId: selectedMessageId, seen: false });
    }
  }, [selectedMessageId, toggleRead]);

  /**
   * Closing returns to the plain list route. The list pane keeps its own view
   * state in the store, so this does not reset which mailbox is shown — and
   * with the pane closed the mailbox route's `MailboxView` never mounts to
   * override it either.
   */
  const handleCloseDetail = useCallback(() => {
    useEmailStore.setState({ selectedMessageId: null });
    router.replace('/');
  }, [router]);

  const helpControl = useDialogControl();
  const handleShowHelp = useCallback(() => {
    helpControl.open();
  }, [helpControl]);

  // Register keyboard shortcuts (web only)
  useKeyboardShortcuts({
    onCompose: handleCompose,
    onReply: handleReply,
    onReplyAll: handleReplyAll,
    onForward: handleForward,
    onArchive: handleArchive,
    onDelete: handleDelete,
    onNextMessage: handleNextMessage,
    onPrevMessage: handlePrevMessage,
    onToggleStar: handleToggleStar,
    onMarkUnread: handleMarkUnread,
    onShowHelp: handleShowHelp,
    enabled: isDesktop,
  });

  if (isDesktop) {
    return (
      <View style={[styles.splitContainer, { backgroundColor: colors.background }]}>
        {/* Both panes transition in CSS via NativeWind: the list narrows and
            the detail pane takes the width it frees, on the same duration and
            curve, so the split reads as one movement. No JS animation driver —
            on web these compile to real CSS transitions. */}
        <View
          className={`min-h-0 transition-[width] duration-300 ease-out ${hasOpenDetail ? 'w-[380px]' : 'w-full'}`}
        >
          <InboxList replaceNavigation />
        </View>
        {/*
          * The detail pane is framed with Bloom's shared `ContentPanel`, the
          * same component Mention's layout uses for its centre column.
          *
          * `<Slot />` renders UNCONDITIONALLY: it is where this layout's child
          * routes mount, and tearing it out of the tree in the same commit that
          * navigates away from a child route leaves that route with nowhere to
          * go. Visibility is a matter of the pane's width and opacity, and
          * `pointerEvents` keeps the hidden pane from swallowing clicks.
          */}
        <View
          className={`min-h-0 overflow-hidden transition-all duration-300 ease-out ${hasOpenDetail ? 'flex-1 opacity-100' : 'w-0 opacity-0'}`}
          style={styles.detailPane}
          pointerEvents={hasOpenDetail ? 'auto' : 'none'}
        >
            <ContentPanel framed maskColor={colors.background}>
              <Slot />
            </ContentPanel>
            {/* Floats over the panel so it works for every child route
                (conversation, compose) without each one wiring its own. */}
            {hasOpenDetail && (
            <TouchableOpacity
              onPress={handleCloseDetail}
              hitSlop={SPACING.sm}
              className="absolute right-5 top-5 h-8 w-8 items-center justify-center rounded-[10px] border"
              style={{ backgroundColor: colors.background, borderColor: colors.border }}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <MaterialCommunityIcons name="close" size={18} color={colors.icon} />
            </TouchableOpacity>
            )}
        </View>
        <KeyboardShortcutsHelp control={helpControl} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[view]" />
      <Stack.Screen name="label/[name]" />
      <Stack.Screen name="conversation/[id]" />
      <Stack.Screen name="compose" />
    </Stack>
  );
}

const styles = StyleSheet.create({
  splitContainer: {
    flex: 1,
    flexDirection: 'row',
    minHeight: 0,
  },
  detailPane: {
    flex: 1,
    minHeight: 0,
    padding: 8,
    paddingLeft: 0,
  },
});
