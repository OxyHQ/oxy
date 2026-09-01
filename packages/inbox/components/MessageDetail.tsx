/**
 * Reusable message detail view.
 *
 * Supports two modes:
 * - standalone: full-screen route with back button (mobile)
 * - embedded: inline panel without back button (desktop split-view)
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  useWindowDimensions,
  Platform,
  Linking,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import { Loading } from '@oxyhq/bloom/loading';
import { Chip } from '@oxyhq/bloom/chip';
import { Dialog, useDialogControl , toast } from '@oxyhq/bloom';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  ArrowLeft01Icon,
  Archive01Icon,
  Delete01Icon,
  StarIcon,
  PinIcon,
  Clock01Icon,
  Attachment01Icon,
  MailReply01Icon,
  MailReplyAll01Icon,
  Forward01Icon,
  MoreHorizontalIcon,
  Mail01Icon,
  SpamIcon,
  LabelIcon,
  PrinterIcon,
} from '@hugeicons/core-free-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOxy } from '@oxyhq/services';

import { useGoBack } from '@/hooks/useGoBack';
import { useColors } from '@/constants/theme';
import { SPECIAL_USE } from '@/constants/mailbox';
import { useEmailStore } from '@/hooks/useEmail';
import { useMessage } from '@/hooks/queries/useMessage';
import { useThread } from '@/hooks/queries/useThread';
import { useMailboxes } from '@/hooks/queries/useMailboxes';
import { useLabels } from '@/hooks/queries/useLabels';
import { useToggleStar, useToggleRead, useArchiveMessage, useDeleteMessage, useUpdateMessageLabels, useTogglePin, useSnoozeMessage } from '@/hooks/mutations/useMessageMutations';
import { SenderAvatar } from '@/components/Avatar';
import { HtmlBody } from '@/components/HtmlBody';
import { InlineReply } from '@/components/InlineReply';
import { ThreadSummary } from '@/components/ThreadSummary';
import { SentimentIndicator } from '@/components/SentimentIndicator';
import { StaleThreadBanner } from '@/components/StaleThreadBanner';
import { useSentimentAnalysis } from '@/hooks/queries/useSentimentAnalysis';
import { useStaleThread } from '@/hooks/queries/useStaleThread';
import { SnoozeSheet } from '@/components/SnoozeSheet';
import { CardRenderer } from '@/components/cards/CardRenderer';
import type { EmailAddress } from '@/services/emailApi';
import { useCidResolver } from '@/hooks/useCidResolver';

function formatFullDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatRecipients(addresses: EmailAddress[]): string {
  return addresses.map((a) => a.name || a.address).join(', ');
}

function formatShortDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const isThisYear = date.getFullYear() === now.getFullYear();

  if (isToday) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (isThisYear) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getSnippet(text: string | null | undefined, maxLength = 100): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > maxLength ? clean.slice(0, maxLength) + '...' : clean;
}

interface MessageDetailProps {
  mode: 'standalone' | 'embedded';
  messageId: string;
}

/**
 * Public wrapper — uses `messageId` as a React key so the inner component
 * unmounts/remounts on message change, naturally resetting all local state
 * (no manual reset effect required).
 */
export function MessageDetail(props: MessageDetailProps) {
  return <MessageDetailInner key={props.messageId} {...props} />;
}

function MessageDetailInner({ mode, messageId }: MessageDetailProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const colors = useColors();

  const { data: currentMessage, isLoading, isError, refetch } = useMessage(messageId);
  const { data: threadMessages = [] } = useThread(messageId);
  const { data: mailboxes = [] } = useMailboxes();
  const { data: labels = [] } = useLabels();
  const currentMailbox = useEmailStore((s) => s.currentMailbox);
  const api = useEmailStore((s) => s._api);
  const toggleStar = useToggleStar();
  const toggleRead = useToggleRead();
  const archiveMutation = useArchiveMessage();
  const deleteMutation = useDeleteMessage();
  const updateLabels = useUpdateMessageLabels();
  const togglePin = useTogglePin();
  const snoozeMutation = useSnoozeMessage();

  const [snoozeVisible, setSnoozeVisible] = useState(false);
  const [replyMode, setReplyMode] = useState<'reply' | 'reply-all' | 'forward' | null>(null);
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set([messageId]));
  const [messageMenuId, setMessageMenuId] = useState<string | null>(null);
  const [threadSummaryRequested, setThreadSummaryRequested] = useState(false);

  const moreMenuControl = useDialogControl();
  const labelPickerControl = useDialogControl();
  const messageMenuControl = useDialogControl();

  // Sentiment analysis for the current message
  const sentiment = useSentimentAnalysis(currentMessage);

  // Get current user for stale thread detection
  const { user, oxyServices } = useOxy();
  const userEmail = user?.email;

  // Marking read is handled by the list tap (see InboxList.handleMessagePress),
  // driven by the markReadOnOpen preference. The detail view intentionally does
  // not mark read on open — a single, predictable path avoids double writes.

  const handleBack = useGoBack();

  const handleStar = useCallback(() => {
    if (!messageId || !currentMessage || toggleStar.isPending) return;
    toggleStar.mutate({ messageId, starred: !currentMessage.flags.starred });
  }, [messageId, currentMessage, toggleStar]);

  const handlePin = useCallback(() => {
    if (!messageId || !currentMessage || togglePin.isPending) return;
    togglePin.mutate({ messageId, pinned: !currentMessage.flags.pinned });
  }, [messageId, currentMessage, togglePin]);

  const handleSnooze = useCallback(
    (until: Date) => {
      if (!messageId) return;
      snoozeMutation.mutate({ messageId, until: until.toISOString() });
      setSnoozeVisible(false);
      if (mode === 'standalone') handleBack();
    },
    [messageId, snoozeMutation, handleBack, mode],
  );

  const handleArchive = useCallback(() => {
    if (!messageId) return;
    const archiveBox = mailboxes.find((m) => m.specialUse === SPECIAL_USE.ARCHIVE);
    if (!archiveBox) {
      toast.error('Archive folder not available.');
      return;
    }
    archiveMutation.mutate({ messageId, archiveMailboxId: archiveBox._id });
    if (mode === 'standalone') handleBack();
  }, [messageId, mailboxes, archiveMutation, handleBack, mode]);

  const handleDelete = useCallback(() => {
    if (!messageId) return;
    const trashBox = mailboxes.find((m) => m.specialUse === SPECIAL_USE.TRASH);
    const isInTrash = currentMailbox?.specialUse === SPECIAL_USE.TRASH;
    deleteMutation.mutate({ messageId, trashMailboxId: trashBox?._id, isInTrash });
    if (mode === 'standalone') handleBack();
  }, [messageId, mailboxes, currentMailbox, deleteMutation, handleBack, mode]);

  const handleMarkUnread = useCallback(() => {
    if (!messageId) return;
    toggleRead.mutate({ messageId, seen: false });
    moreMenuControl.close();
    if (mode === 'standalone') handleBack();
  }, [messageId, toggleRead, handleBack, mode, moreMenuControl]);

  const handleMarkSpam = useCallback(() => {
    if (!messageId) return;
    const spamBox = mailboxes.find((m) => m.specialUse === SPECIAL_USE.SPAM);
    if (spamBox) {
      archiveMutation.mutate({ messageId, archiveMailboxId: spamBox._id });
    }
    moreMenuControl.close();
    if (mode === 'standalone') handleBack();
  }, [messageId, mailboxes, archiveMutation, handleBack, mode, moreMenuControl]);

  const handleReply = useCallback((targetMsgId?: string) => {
    if (!currentMessage) return;
    setReplyTargetId(targetMsgId || null);
    setReplyMode('reply');
    setMessageMenuId(null);
  }, [currentMessage]);

  const handleReplyAll = useCallback((targetMsgId?: string) => {
    if (!currentMessage) return;
    setReplyTargetId(targetMsgId || null);
    setReplyMode('reply-all');
    setMessageMenuId(null);
  }, [currentMessage]);

  const handleForward = useCallback((targetMsgId?: string) => {
    if (!currentMessage) return;
    setReplyTargetId(targetMsgId || null);
    setReplyMode('forward');
    setMessageMenuId(null);
  }, [currentMessage]);

  const handleCloseReply = useCallback(() => {
    setReplyMode(null);
    setReplyTargetId(null);
  }, []);

  const toggleMessageExpanded = useCallback((msgId: string) => {
    setExpandedMessages((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) {
        next.delete(msgId);
      } else {
        next.add(msgId);
      }
      return next;
    });
  }, []);

  // Sort thread messages by date (oldest first for conversation view)
  const sortedThread = useMemo(() => {
    if (threadMessages.length === 0) return currentMessage ? [currentMessage] : [];
    return [...threadMessages].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
  }, [threadMessages, currentMessage]);

  // Detect stale threads that need a response
  const staleInfo = useStaleThread(sortedThread, userEmail);

  // Resolve CID inline image references to signed File Manager URLs
  const resolvedHtmlMap = useCidResolver(sortedThread, oxyServices, messageId);

  const handleAttachment = useCallback(async (fileId: string, filename: string) => {
    try {
      const url = await oxyServices.getFileDownloadUrlAsync(fileId);
      if (Platform.OS === 'web') {
        window.open(url, '_blank');
      } else {
        const documentDirectory = FileSystem.documentDirectory;
        if (!documentDirectory) {
          await Linking.openURL(url);
          return;
        }
        const localUri = documentDirectory + filename;
        const { uri } = await FileSystem.downloadAsync(url, localUri);
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(uri);
        } else {
          await Linking.openURL(url);
        }
      }
    } catch {
      try {
        const url = await oxyServices.getFileDownloadUrlAsync(fileId);
        await Linking.openURL(url);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to download attachment.';
        toast.error(message);
      }
    }
  }, [oxyServices]);

  const handleToggleLabel = useCallback((labelName: string) => {
    if (!currentMessage) return;
    const hasLabel = currentMessage.labels.includes(labelName);
    updateLabels.mutate({
      messageId,
      add: hasLabel ? [] : [labelName],
      remove: hasLabel ? [labelName] : [],
    });
  }, [currentMessage, messageId, updateLabels]);

  const handlePrint = useCallback(() => {
    if (!currentMessage) return;
    const subject = currentMessage.subject || '(no subject)';
    const fromStr = currentMessage.from.name
      ? `${currentMessage.from.name} <${currentMessage.from.address}>`
      : currentMessage.from.address;
    const toStr = currentMessage.to.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(', ');
    const ccStr = currentMessage.cc?.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(', ') || '';
    const dateStr = formatFullDate(currentMessage.date);
    const bodyHtml = currentMessage.html || `<pre>${currentMessage.text || ''}</pre>`;

    const printHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${subject}</title>
<style>
  body { margin: 0; padding: 24px; background: #fff; color: #000; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.5; }
  .header { border-bottom: 1px solid #ddd; padding-bottom: 16px; margin-bottom: 16px; }
  .subject { font-size: 20px; font-weight: 400; margin: 0 0 12px 0; }
  .field { margin: 2px 0; }
  .label { font-weight: 600; display: inline-block; min-width: 50px; }
  .body { margin-top: 16px; }
  img { max-width: 100%; height: auto; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
<div class="header">
  <h1 class="subject">${subject}</h1>
  <div class="field"><span class="label">From:</span> ${fromStr}</div>
  <div class="field"><span class="label">To:</span> ${toStr}</div>
  ${ccStr ? `<div class="field"><span class="label">Cc:</span> ${ccStr}</div>` : ''}
  <div class="field"><span class="label">Date:</span> ${dateStr}</div>
</div>
<div class="body">${bodyHtml}</div>
</body>
</html>`;

    if (Platform.OS === 'web') {
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        printWindow.document.write(printHtml);
        printWindow.document.close();
        printWindow.focus();
        printWindow.print();
      }
    } else {
      (async () => {
        try {
          await Print.printAsync({ html: printHtml });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Failed to print email.';
          toast.error(message);
        }
      })();
    }
  }, [currentMessage]);

  const handleDownloadEml = useCallback(() => {
    if (!currentMessage) return;
    moreMenuControl.close();

    const subject = currentMessage.subject || '(no subject)';
    const fromStr = currentMessage.from.name
      ? `${currentMessage.from.name} <${currentMessage.from.address}>`
      : currentMessage.from.address;
    const toStr = currentMessage.to.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(', ');
    const ccStr = currentMessage.cc?.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(', ') || '';
    const dateStr = new Date(currentMessage.date).toUTCString();
    const msgId = currentMessage.messageId || `<${currentMessage._id}@inbox.oxy.so>`;
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const textBody = currentMessage.text || '';
    const htmlBody = currentMessage.html || '';

    let mimeBody: string;
    if (htmlBody && textBody) {
      mimeBody = [
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        textBody,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        htmlBody,
        '',
        `--${boundary}--`,
      ].join('\r\n');
    } else if (htmlBody) {
      mimeBody = [
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        htmlBody,
      ].join('\r\n');
    } else {
      mimeBody = [
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        textBody || '',
      ].join('\r\n');
    }

    const headers = [
      `From: ${fromStr}`,
      `To: ${toStr}`,
      ...(ccStr ? [`Cc: ${ccStr}`] : []),
      `Subject: ${subject}`,
      `Date: ${dateStr}`,
      `Message-ID: ${msgId}`,
      'MIME-Version: 1.0',
    ].join('\r\n');

    const emlContent = `${headers}\r\n${mimeBody}`;

    const safeSubject = subject.replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 60).trim();
    const filename = `${safeSubject}.eml`;

    if (Platform.OS === 'web') {
      const blob = new Blob([emlContent], { type: 'message/rfc822' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else {
      (async () => {
        try {
          const documentDirectory = FileSystem.documentDirectory;
          if (!documentDirectory) {
            toast.error('File system not available on this device.');
            return;
          }
          const fileUri = `${documentDirectory}${filename}`;
          await FileSystem.writeAsStringAsync(fileUri, emlContent, { encoding: FileSystem.EncodingType.UTF8 });
          if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(fileUri, { mimeType: 'message/rfc822', dialogTitle: 'Save email' });
          } else {
            toast.error('Sharing is not available on this device.');
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Failed to download email.';
          toast.error(message);
        }
      })();
    }
  }, [currentMessage]);

  // Label data for assigned labels (backend stores label names, not IDs)
  const assignedLabels = useMemo(() => {
    if (!currentMessage) return [];
    return labels.filter((l) => currentMessage.labels.includes(l.name));
  }, [currentMessage, labels]);

  const shellStyle = [
    styles.container,
    { backgroundColor: colors.background },
    mode === 'standalone' && { paddingTop: insets.top },
  ];

  const standaloneToolbar =
    mode === 'standalone' ? (
      <View
        style={[
          styles.toolbar,
          {
            paddingLeft: 4 + insets.left,
            paddingRight: 4 + insets.right,
          },
        ]}
      >
        <TouchableOpacity onPress={handleBack} style={styles.iconButton}>
          {Platform.OS === 'web' ? (
            <HugeiconsIcon icon={ArrowLeft01Icon as unknown as IconSvgElement} size={24} color={colors.icon} />
          ) : (
            <MaterialCommunityIcons name="arrow-left" size={24} color={colors.icon} />
          )}
        </TouchableOpacity>
      </View>
    ) : null;

  if (isLoading) {
    return (
      <View style={shellStyle}>
        {standaloneToolbar}
        <View style={styles.loadingContainer}>
          <Loading />
        </View>
      </View>
    );
  }

  if (isError) {
    return (
      <View style={shellStyle}>
        {standaloneToolbar}
        <View style={styles.loadingContainer}>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>Couldn't load this message</Text>
          <Text style={[styles.emptySubtitle, { color: colors.secondaryText }]}>
            Check your connection and try again.
          </Text>
          <TouchableOpacity onPress={() => refetch()} style={styles.retryButton}>
            <Text style={[styles.retryButtonText, { color: colors.primary }]}>Try again</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (!currentMessage) {
    return (
      <View style={shellStyle}>
        {standaloneToolbar}
        <View style={styles.loadingContainer}>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>Message not found</Text>
          <Text style={[styles.emptySubtitle, { color: colors.secondaryText }]}>
            This message may have been deleted or moved.
          </Text>
        </View>
      </View>
    );
  }

  // No maxContentWidth - use full available width like Gmail

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.background },
        mode === 'standalone' && { paddingTop: insets.top },
      ]}
    >
      {/* Toolbar */}
      <View
        style={[
          styles.toolbar,
          {
            borderBottomColor: colors.border,
            paddingLeft: 4 + insets.left,
            paddingRight: 4 + insets.right,
          },
        ]}
      >
        {mode === 'standalone' && (
          <TouchableOpacity onPress={handleBack} style={styles.iconButton}>
            {Platform.OS === 'web' ? (
              <HugeiconsIcon icon={ArrowLeft01Icon as unknown as IconSvgElement} size={24} color={colors.icon} />
            ) : (
              <MaterialCommunityIcons name="arrow-left" size={24} color={colors.icon} />
            )}
          </TouchableOpacity>
        )}
        <View style={styles.toolbarSpacer} />
        <TouchableOpacity
          accessibilityLabel="Archive"
          accessibilityRole="button"
          onPress={handleArchive}
          style={styles.iconButton}
        >
          {Platform.OS === 'web' ? (
            <HugeiconsIcon icon={Archive01Icon as unknown as IconSvgElement} size={22} color={colors.icon} />
          ) : (
            <MaterialCommunityIcons name="archive-outline" size={22} color={colors.icon} />
          )}
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityLabel="Delete"
          accessibilityRole="button"
          onPress={handleDelete}
          style={styles.iconButton}
        >
          {Platform.OS === 'web' ? (
            <HugeiconsIcon icon={Delete01Icon as unknown as IconSvgElement} size={22} color={colors.icon} />
          ) : (
            <MaterialCommunityIcons name="delete-outline" size={22} color={colors.icon} />
          )}
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityLabel="Mark as unread"
          accessibilityRole="button"
          onPress={handleMarkUnread}
          style={styles.iconButton}
        >
          {Platform.OS === 'web' ? (
            <HugeiconsIcon icon={Mail01Icon as unknown as IconSvgElement} size={22} color={colors.icon} />
          ) : (
            <MaterialCommunityIcons name="email-mark-as-unread" size={22} color={colors.icon} />
          )}
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityLabel={currentMessage.flags.pinned ? 'Unpin message' : 'Pin message'}
          accessibilityRole="button"
          accessibilityState={{ selected: currentMessage.flags.pinned }}
          onPress={handlePin}
          style={[styles.iconButton, togglePin.isPending && { opacity: 0.5 }]}
          disabled={togglePin.isPending}
        >
          {Platform.OS === 'web' ? (
            <HugeiconsIcon
              icon={PinIcon as unknown as IconSvgElement}
              size={22}
              color={currentMessage.flags.pinned ? colors.primary : colors.icon}
              strokeWidth={1.5}
              fill={currentMessage.flags.pinned ? colors.primary : 'none'}
            />
          ) : (
            <MaterialCommunityIcons
              name={currentMessage.flags.pinned ? 'pin' : 'pin-outline'}
              size={22}
              color={currentMessage.flags.pinned ? colors.primary : colors.icon}
            />
          )}
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityLabel={currentMessage.flags.starred ? 'Unstar message' : 'Star message'}
          accessibilityRole="button"
          accessibilityState={{ selected: currentMessage.flags.starred }}
          onPress={handleStar}
          style={[styles.iconButton, toggleStar.isPending && { opacity: 0.5 }]}
          disabled={toggleStar.isPending}
        >
          {Platform.OS === 'web' ? (
            <HugeiconsIcon
              icon={StarIcon as unknown as IconSvgElement}
              size={22}
              color={currentMessage.flags.starred ? colors.starred : colors.icon}
              strokeWidth={1.5}
              fill={currentMessage.flags.starred ? colors.starred : 'none'}
            />
          ) : (
            <MaterialCommunityIcons
              name={currentMessage.flags.starred ? 'star' : 'star-outline'}
              size={22}
              color={currentMessage.flags.starred ? colors.starred : colors.icon}
            />
          )}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setSnoozeVisible(true)} style={styles.iconButton}>
          {Platform.OS === 'web' ? (
            <HugeiconsIcon icon={Clock01Icon as unknown as IconSvgElement} size={22} color={colors.icon} />
          ) : (
            <MaterialCommunityIcons name="clock-outline" size={22} color={colors.icon} />
          )}
        </TouchableOpacity>
        <TouchableOpacity onPress={handlePrint} style={styles.iconButton}>
          {Platform.OS === 'web' ? (
            <HugeiconsIcon icon={PrinterIcon as unknown as IconSvgElement} size={22} color={colors.icon} />
          ) : (
            <MaterialCommunityIcons name="printer-outline" size={22} color={colors.icon} />
          )}
        </TouchableOpacity>

        {/* More menu */}
        <TouchableOpacity onPress={() => moreMenuControl.open()} style={styles.iconButton}>
          {Platform.OS === 'web' ? (
            <HugeiconsIcon icon={MoreHorizontalIcon as unknown as IconSvgElement} size={22} color={colors.icon} />
          ) : (
            <MaterialCommunityIcons name="dots-vertical" size={22} color={colors.icon} />
          )}
        </TouchableOpacity>
      </View>

      {/* More menu dialog */}
      <Dialog control={moreMenuControl} label="More actions" style={{ padding: 0 }}>
        <TouchableOpacity style={styles.menuItem} onPress={handleMarkUnread} activeOpacity={0.6}>
          {Platform.OS === 'web' ? (
            <HugeiconsIcon icon={Mail01Icon as unknown as IconSvgElement} size={16} color={colors.icon} />
          ) : (
            <MaterialCommunityIcons name="email-mark-as-unread" size={16} color={colors.icon} />
          )}
          <Text style={[styles.menuItemText, { color: colors.text }]}>Mark unread</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem} onPress={handleMarkSpam} activeOpacity={0.6}>
          {Platform.OS === 'web' ? (
            <HugeiconsIcon icon={SpamIcon as unknown as IconSvgElement} size={16} color={colors.icon} />
          ) : (
            <MaterialCommunityIcons name="alert-octagon-outline" size={16} color={colors.icon} />
          )}
          <Text style={[styles.menuItemText, { color: colors.text }]}>Report spam</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem} onPress={() => { moreMenuControl.close(); labelPickerControl.open(); }} activeOpacity={0.6}>
          {Platform.OS === 'web' ? (
            <HugeiconsIcon icon={LabelIcon as unknown as IconSvgElement} size={16} color={colors.icon} />
          ) : (
            <MaterialCommunityIcons name="label-outline" size={16} color={colors.icon} />
          )}
          <Text style={[styles.menuItemText, { color: colors.text }]}>Label</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem} onPress={handleDownloadEml} activeOpacity={0.6}>
          {Platform.OS === 'web' ? (
            <HugeiconsIcon icon={Mail01Icon as unknown as IconSvgElement} size={16} color={colors.icon} />
          ) : (
            <MaterialCommunityIcons name="email-arrow-right-outline" size={16} color={colors.icon} />
          )}
          <Text style={[styles.menuItemText, { color: colors.text }]}>Download .eml</Text>
        </TouchableOpacity>
      </Dialog>

      {/* Label picker dialog */}
      <Dialog control={labelPickerControl} label="Labels" style={{ padding: 0 }}>
        <Text style={[styles.labelPickerTitle, { color: colors.text }]}>Labels</Text>
        {labels.length === 0 && (
          <Text style={[styles.labelPickerEmpty, { color: colors.secondaryText }]}>No labels yet</Text>
        )}
        {labels.map((lbl) => {
          const isAssigned = currentMessage.labels.includes(lbl.name);
          return (
            <TouchableOpacity
              key={lbl._id}
              style={styles.labelPickerItem}
              onPress={() => handleToggleLabel(lbl.name)}
              activeOpacity={0.6}
            >
              <View style={[styles.labelDot, { backgroundColor: lbl.color }]} />
              <Text style={[styles.labelPickerItemText, { color: colors.text }]}>{lbl.name}</Text>
              {isAssigned && (
                <MaterialCommunityIcons name="check" size={16} color={colors.primary} />
              )}
            </TouchableOpacity>
          );
        })}
      </Dialog>

      <ScrollView
        style={styles.body}
        contentContainerStyle={[
          styles.bodyContent,
          { paddingBottom: replyMode ? (mode === 'standalone' ? insets.bottom + 16 : 16) : 16 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Subject and metadata - with horizontal padding */}
        <View style={styles.contentPadded}>
          <View style={styles.subjectRow}>
            <Text style={[styles.subject, { color: colors.text }]}>{currentMessage.subject || '(no subject)'}</Text>
            {sentiment && <SentimentIndicator sentiment={sentiment} size="medium" showLabel />}
          </View>

          {/* Label chips */}
          {assignedLabels.length > 0 && (
            <View style={styles.labelChips}>
              {assignedLabels.map((lbl) => (
                <Chip
                  key={lbl._id}
                  variant="soft"
                  size="small"
                  onClose={() => handleToggleLabel(lbl.name)}
                >
                  {lbl.name}
                </Chip>
              ))}
            </View>
          )}

          {/* Thread count indicator */}
          {sortedThread.length > 1 && (
            <View style={[styles.threadCount, { backgroundColor: colors.surfaceVariant }]}>
              <Text style={[styles.threadCountText, { color: colors.secondaryText }]}>
                {sortedThread.length} messages in this conversation
              </Text>
            </View>
          )}

          {/* AI Thread Summary - requires explicit user action before sending thread content to Alia */}
          {sortedThread.length >= 4 && (
            threadSummaryRequested ? (
              <ThreadSummary messages={sortedThread} minMessages={4} />
            ) : (
              <TouchableOpacity
                style={[
                  styles.threadSummaryPrompt,
                  { backgroundColor: colors.surfaceVariant, borderColor: colors.border },
                ]}
                onPress={() => setThreadSummaryRequested(true)}
                activeOpacity={0.75}
              >
                <MaterialCommunityIcons name="robot-outline" size={18} color={colors.primary} />
                <View style={styles.threadSummaryPromptText}>
                  <Text style={[styles.threadSummaryPromptTitle, { color: colors.text }]}>
                    Generate AI thread summary
                  </Text>
                  <Text style={[styles.threadSummaryPromptDescription, { color: colors.secondaryText }]}>
                    Sends this conversation to Alia for summarization.
                  </Text>
                </View>
              </TouchableOpacity>
            )
          )}
        </View>

        {/* Rich card for structured data (flights, orders, etc.) */}
        {currentMessage.card && (
          <View style={styles.cardSection}>
            <CardRenderer card={currentMessage.card} />
          </View>
        )}

        {/* Highlights (key data points) */}
        {currentMessage.highlights && currentMessage.highlights.length > 0 && (
          <View style={[styles.highlightsSection, { borderColor: colors.border }]}>
            {currentMessage.highlights.map((h, i) => (
              <View key={i} style={styles.highlightRow}>
                <Text style={[styles.highlightLabel, { color: colors.secondaryText }]}>{h.label}</Text>
                <Text style={[styles.highlightValue, { color: colors.text }]}>{h.value}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Stale thread banner - gentle nudge to reply */}
        <StaleThreadBanner
          staleInfo={staleInfo}
          onReply={() => handleReply()}
        />

        {/* Thread messages */}
        {sortedThread.map((msg, index) => {
          const isExpanded = expandedMessages.has(msg._id);
          const msgSenderName = msg.from.name || msg.from.address.split('@')[0];
          const isLast = index === sortedThread.length - 1;

          if (!isExpanded) {
            // Collapsed thread message
            return (
              <View key={msg._id} style={styles.contentPadded}>
                <TouchableOpacity
                  style={[
                    styles.collapsedMessage,
                    { borderBottomColor: colors.border },
                    isLast && { borderBottomWidth: 0 },
                  ]}
                  onPress={() => toggleMessageExpanded(msg._id)}
                  activeOpacity={0.7}
                >
                  <SenderAvatar avatarPath={msg.senderAvatarPath} name={msgSenderName} size={36} />
                  <View style={styles.collapsedMessageContent}>
                    <View style={styles.collapsedMessageHeader}>
                      <Text style={[styles.collapsedSenderName, { color: colors.text }]} numberOfLines={1}>
                        {msgSenderName}
                      </Text>
                      <Text style={[styles.collapsedDate, { color: colors.secondaryText }]}>
                        {formatShortDate(msg.date)}
                      </Text>
                    </View>
                    <Text style={[styles.collapsedSnippet, { color: colors.secondaryText }]} numberOfLines={1}>
                      {getSnippet(msg.text)}
                    </Text>
                  </View>
                  {msg.attachments.length > 0 && (
                    <MaterialCommunityIcons name="paperclip" size={14} color={colors.secondaryText} />
                  )}
                </TouchableOpacity>
              </View>
            );
          }

          // Expanded thread message
          return (
            <View
              key={msg._id}
              style={[
                styles.expandedMessage,
                { borderBottomColor: colors.border },
                isLast && { borderBottomWidth: 0 },
              ]}
            >
              {/* Sender header - with padding */}
              <View style={styles.contentPadded}>
                <View style={styles.senderRow}>
                  <TouchableOpacity
                    onPress={() => sortedThread.length > 1 ? toggleMessageExpanded(msg._id) : undefined}
                    activeOpacity={sortedThread.length > 1 ? 0.7 : 1}
                    style={styles.senderRowMain}
                  >
                    <SenderAvatar avatarPath={msg.senderAvatarPath} name={msgSenderName} size={40} />
                    <View style={styles.senderInfo}>
                      <View style={styles.senderNameRow}>
                        <Text style={[styles.senderName, { color: colors.text }]}>{msgSenderName}</Text>
                        <Text style={[styles.messageDate, { color: colors.secondaryText }]}>
                          {formatShortDate(msg.date)}
                        </Text>
                      </View>
                      <Text style={[styles.toLine, { color: colors.secondaryText }]} numberOfLines={1}>
                        to {formatRecipients(msg.to)}
                        {msg.cc && msg.cc.length > 0 ? `, cc: ${formatRecipients(msg.cc)}` : ''}
                      </Text>
                    </View>
                  </TouchableOpacity>

                  {/* Message action icons - like Gmail */}
                  <View style={styles.messageActions}>
                    <TouchableOpacity
                      style={styles.messageActionButton}
                      onPress={() => handleReply(msg._id)}
                      activeOpacity={0.7}
                    >
                      {Platform.OS === 'web' ? (
                        <HugeiconsIcon icon={MailReply01Icon as unknown as IconSvgElement} size={18} color={colors.icon} />
                      ) : (
                        <MaterialCommunityIcons name="reply" size={18} color={colors.icon} />
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.messageActionButton}
                      onPress={() => {
                        setMessageMenuId(msg._id);
                        messageMenuControl.open();
                      }}
                      activeOpacity={0.7}
                    >
                      {Platform.OS === 'web' ? (
                        <HugeiconsIcon icon={MoreHorizontalIcon as unknown as IconSvgElement} size={18} color={colors.icon} />
                      ) : (
                        <MaterialCommunityIcons name="dots-vertical" size={18} color={colors.icon} />
                      )}
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Attachments */}
                {msg.attachments.length > 0 && (
                  <View style={[styles.attachmentsBar, { borderColor: colors.border }]}>
                    {msg.attachments.map((att, i) => (
                      <TouchableOpacity
                        key={att.fileId || i}
                        style={[styles.attachmentChip, { backgroundColor: colors.surfaceVariant }]}
                        onPress={() => handleAttachment(att.fileId, att.name)}
                        activeOpacity={0.7}
                      >
                        {Platform.OS === 'web' ? (
                          <HugeiconsIcon icon={Attachment01Icon as unknown as IconSvgElement} size={14} color={colors.secondaryText} />
                        ) : (
                          <MaterialCommunityIcons name="paperclip" size={14} color={colors.secondaryText} />
                        )}
                        <Text style={[styles.attachmentName, { color: colors.text }]} numberOfLines={1}>
                          {att.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>

              {/* Body - full width with consistent padding */}
              <View style={styles.messageBody}>
                {msg.html ? (
                  <View style={styles.contentPadded}>
                    <HtmlBody html={resolvedHtmlMap[msg._id] ?? msg.html ?? ''} />
                  </View>
                ) : (
                  <View style={styles.contentPadded}>
                    <Text style={[styles.bodyText, { color: colors.text }]}>
                      {msg.text || '(empty message)'}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          );
        })}

        {/* Inline reply - appears at bottom of thread, inside scroll area */}
        {replyMode && (
          <View style={[styles.inlineReplyWrapper, { marginTop: 16 }]}>
            <InlineReply
              key={`${replyMode}:${replyTargetId ?? currentMessage._id}`}
              message={replyTargetId ? (sortedThread.find(m => m._id === replyTargetId) || currentMessage) : currentMessage}
              mode={replyMode}
              onClose={handleCloseReply}
            />
          </View>
        )}
      </ScrollView>

      {/* Snooze sheet */}
      <SnoozeSheet
        visible={snoozeVisible}
        onClose={() => setSnoozeVisible(false)}
        onSnooze={handleSnooze}
      />

      {/* Per-message action dialog */}
      <Dialog
        control={messageMenuControl}
        onClose={() => setMessageMenuId(null)}
        label="Message actions"
        style={{ padding: 0 }}
      >
        <TouchableOpacity style={styles.menuItem} onPress={() => handleReply(messageMenuId ?? undefined)} activeOpacity={0.6}>
          {Platform.OS === 'web' ? (
            <HugeiconsIcon icon={MailReply01Icon as unknown as IconSvgElement} size={16} color={colors.icon} />
          ) : (
            <MaterialCommunityIcons name="reply" size={16} color={colors.icon} />
          )}
          <Text style={[styles.menuItemText, { color: colors.text }]}>Reply</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem} onPress={() => handleReplyAll(messageMenuId ?? undefined)} activeOpacity={0.6}>
          {Platform.OS === 'web' ? (
            <HugeiconsIcon icon={MailReplyAll01Icon as unknown as IconSvgElement} size={16} color={colors.icon} />
          ) : (
            <MaterialCommunityIcons name="reply-all" size={16} color={colors.icon} />
          )}
          <Text style={[styles.menuItemText, { color: colors.text }]}>Reply all</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem} onPress={() => handleForward(messageMenuId ?? undefined)} activeOpacity={0.6}>
          {Platform.OS === 'web' ? (
            <HugeiconsIcon icon={Forward01Icon as unknown as IconSvgElement} size={16} color={colors.icon} />
          ) : (
            <MaterialCommunityIcons name="share" size={16} color={colors.icon} />
          )}
          <Text style={[styles.menuItemText, { color: colors.text }]}>Forward</Text>
        </TouchableOpacity>
      </Dialog>

      {/* Sticky reply buttons at bottom */}
      {!replyMode && (
        <View
          style={[
            styles.stickyReplyBar,
            {
              backgroundColor: colors.background,
              borderTopColor: colors.border,
              paddingBottom: mode === 'standalone' ? insets.bottom + 8 : 8,
            },
          ]}
        >
          <TouchableOpacity
            accessibilityLabel="Reply"
            accessibilityRole="button"
            style={[styles.replyButton, { borderColor: colors.border }]}
            onPress={() => handleReply()}
            activeOpacity={0.7}
          >
            {Platform.OS === 'web' ? (
              <HugeiconsIcon icon={MailReply01Icon as unknown as IconSvgElement} size={18} color={colors.icon} />
            ) : (
              <MaterialCommunityIcons name="reply" size={18} color={colors.icon} />
            )}
            <Text style={[styles.replyButtonText, { color: colors.text }]}>Reply</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityLabel="Reply all"
            accessibilityRole="button"
            style={[styles.replyButton, { borderColor: colors.border }]}
            onPress={() => handleReplyAll()}
            activeOpacity={0.7}
          >
            {Platform.OS === 'web' ? (
              <HugeiconsIcon icon={MailReplyAll01Icon as unknown as IconSvgElement} size={18} color={colors.icon} />
            ) : (
              <MaterialCommunityIcons name="reply-all" size={18} color={colors.icon} />
            )}
            <Text style={[styles.replyButtonText, { color: colors.text }]}>Reply All</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityLabel="Forward"
            accessibilityRole="button"
            style={[styles.replyButton, { borderColor: colors.border }]}
            onPress={() => handleForward()}
            activeOpacity={0.7}
          >
            {Platform.OS === 'web' ? (
              <HugeiconsIcon icon={Forward01Icon as unknown as IconSvgElement} size={18} color={colors.icon} />
            ) : (
              <MaterialCommunityIcons name="share" size={18} color={colors.icon} />
            )}
            <Text style={[styles.replyButtonText, { color: colors.text }]}>Forward</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  // `paddingLeft` / `paddingRight` are applied inline so they can include
  // landscape `insets.left` / `insets.right` (leading back button clips
  // under left notch otherwise).
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toolbarSpacer: {
    flex: 1,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
  },
  menuItemText: {
    fontSize: 13,
    fontWeight: '500',
  },
  labelPickerTitle: {
    fontSize: 13,
    fontWeight: '600',
    paddingHorizontal: 14,
    paddingBottom: 6,
  },
  labelPickerEmpty: {
    fontSize: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  labelPickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 10,
  },
  labelPickerItemText: {
    fontSize: 13,
    flex: 1,
  },
  labelDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  retryButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    paddingTop: 16,
  },
  contentPadded: {
    paddingHorizontal: 16,
  },
  subjectRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 8,
  },
  subject: {
    fontSize: 22,
    fontWeight: '400',
    lineHeight: 30,
    flex: 1,
  },
  labelChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 12,
  },
  cardSection: {
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  highlightsSection: {
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 10,
    gap: 6,
  },
  highlightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  highlightLabel: {
    fontSize: 12,
    fontWeight: '500',
    minWidth: 80,
  },
  highlightValue: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  senderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 16,
  },
  senderRowMain: {
    flexDirection: 'row',
    flex: 1,
    gap: 12,
  },
  senderInfo: {
    flex: 1,
  },
  messageActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 0,
    marginTop: 4,
  },
  messageActionButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
  },
  senderNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  senderName: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  messageDate: {
    fontSize: 12,
  },
  toLine: {
    fontSize: 13,
    marginTop: 2,
  },
  senderDetails: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  detailRow: {
    flexDirection: 'row',
    gap: 8,
  },
  detailLabel: {
    fontSize: 12,
    fontWeight: '600',
    width: 40,
  },
  detailValue: {
    fontSize: 12,
    flex: 1,
  },
  attachmentsBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  attachmentName: {
    fontSize: 13,
    maxWidth: 180,
  },
  messageBody: {
    marginTop: 8,
  },
  bodyText: {
    fontSize: 15,
    lineHeight: 24,
  },
  stickyReplyBar: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  replyButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
  },
  replyButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  // Thread view styles
  threadCount: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    alignSelf: 'flex-start',
    marginBottom: 16,
  },
  threadCountText: {
    fontSize: 12,
    fontWeight: '500',
  },
  threadSummaryPrompt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 16,
  },
  threadSummaryPromptText: {
    flex: 1,
    gap: 2,
  },
  threadSummaryPromptTitle: {
    fontSize: 13,
    fontWeight: '600',
  },
  threadSummaryPromptDescription: {
    fontSize: 12,
  },
  collapsedMessage: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  collapsedMessageContent: {
    flex: 1,
  },
  collapsedMessageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  collapsedSenderName: {
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  collapsedDate: {
    fontSize: 12,
  },
  collapsedSnippet: {
    fontSize: 13,
    marginTop: 2,
  },
  expandedMessage: {
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  inlineReplyWrapper: {
    width: '100%',
  },
});
