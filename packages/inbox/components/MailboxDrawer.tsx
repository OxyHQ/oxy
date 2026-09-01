/**
 * Drawer sidebar listing mailboxes, starred, labels, and compose.
 *
 * Auth-aware: when signed-out the nav body is replaced with a sign-in card and
 * the bottom Account row becomes the same CTA. Auth-only affordances (Compose
 * pill, Create folder) are hidden until the user is authenticated.
 */

import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy, OxySignInButton, openAccountDialog, ProfileButton } from '@oxyhq/services';
import { Dialog, useDialogControl } from '@oxyhq/bloom';
import { Button } from '@oxyhq/bloom/button';
import { useRouter, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { Badge } from '@oxyhq/bloom/badge';
import {
  FavouriteIcon,
  InboxIcon,
  SentIcon,
  NoteEditIcon,
  Delete01Icon,
  SpamIcon,
  Archive01Icon,
  StarIcon as HugeStarIcon,
  Folder01Icon,
  LabelIcon,
  SidebarLeft01Icon,
  SidebarRight01Icon,
  PencilEdit01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Mail01Icon,
  Clock01Icon,
  Add01Icon,
} from '@hugeicons/core-free-icons';
import { useColors } from '@/constants/theme';
import { Divider } from '@oxyhq/bloom/divider';
import { SPECIAL_USE } from '@/constants/mailbox';
import { useEmailStore } from '@/hooks/useEmail';
import { emailKeys } from '@/hooks/queries/queryKeys';
import { clearPersistedInboxCache } from '@/hooks/queries/queryClient';
import { useMailboxes } from '@/hooks/queries/useMailboxes';
import { useLabels } from '@/hooks/queries/useLabels';
import { useCreateMailbox, useDeleteMailbox } from '@/hooks/mutations/useMailboxMutations';
import type { Mailbox } from '@/services/emailApi';
import { LogoIcon } from '@/assets/logo';

const MAILBOX_ICONS_FALLBACK: Record<string, keyof typeof MaterialCommunityIcons.glyphMap> = {
  Inbox: 'inbox',
  Sent: 'send',
  Drafts: 'file-document-edit-outline',
  Trash: 'delete-outline',
  Spam: 'alert-octagon-outline',
  Archive: 'archive-outline',
  Starred: 'star-outline',
  Snoozed: 'clock-outline',
};

const MAILBOX_HUGE_ICONS: Record<string, IconSvgElement> = {
  Inbox: InboxIcon as unknown as IconSvgElement,
  Sent: SentIcon as unknown as IconSvgElement,
  Drafts: NoteEditIcon as unknown as IconSvgElement,
  Trash: Delete01Icon as unknown as IconSvgElement,
  Spam: SpamIcon as unknown as IconSvgElement,
  Archive: Archive01Icon as unknown as IconSvgElement,
  Starred: HugeStarIcon as unknown as IconSvgElement,
  Snoozed: Clock01Icon as unknown as IconSvgElement,
};

// Primary mailboxes shown by default; the rest go behind "More"
const PRIMARY_SPECIAL_USE: Set<string> = new Set([SPECIAL_USE.INBOX, SPECIAL_USE.SENT, SPECIAL_USE.DRAFTS]);

function getMailboxFallbackIcon(mailbox: Mailbox): keyof typeof MaterialCommunityIcons.glyphMap {
  if (mailbox.specialUse) {
    const normalized = mailbox.specialUse.replace(/^\\+/, '');
    if (MAILBOX_ICONS_FALLBACK[normalized]) {
      return MAILBOX_ICONS_FALLBACK[normalized];
    }
  }
  return 'folder-outline';
}

function getMailboxHugeIcon(mailbox: Mailbox): IconSvgElement {
  if (mailbox.specialUse) {
    const normalized = mailbox.specialUse.replace(/^\\+/, '');
    if (MAILBOX_HUGE_ICONS[normalized]) {
      return MAILBOX_HUGE_ICONS[normalized];
    }
  }
  return Folder01Icon as unknown as IconSvgElement;
}

function NavItem({
  icon,
  hugeIcon,
  label,
  isActive,
  colors,
  badge,
  collapsed,
  bold,
  colorDot,
  onPress,
  onLongPress,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  hugeIcon: IconSvgElement;
  label: string;
  isActive: boolean;
  colors: ReturnType<typeof useColors>;
  badge?: number;
  collapsed?: boolean;
  bold?: boolean;
  colorDot?: string;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const iconColor = isActive ? colors.sidebarItemActiveText : colors.icon;
  const accessibilityLabel = badge != null && badge > 0 ? `${label}, ${badge} unread` : label;
  return (
    <TouchableOpacity
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="link"
      accessibilityState={{ selected: isActive }}
      style={[
        styles.item,
        isActive && { backgroundColor: colors.sidebarItemActive },
        collapsed && styles.itemCollapsed,
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.7}
    >
      {colorDot ? (
        <View style={[styles.colorDot, { backgroundColor: colorDot }]} />
      ) : Platform.OS === 'web' ? (
        <HugeiconsIcon icon={hugeIcon} size={20} color={iconColor} strokeWidth={2} />
      ) : (
        <MaterialCommunityIcons name={icon} size={20} color={iconColor} />
      )}
      {!collapsed && (
        <>
          <Text
            style={[
              styles.itemLabel,
              { color: isActive ? colors.sidebarItemActiveText : colors.sidebarText },
              (isActive || bold) && styles.itemLabelActive,
            ]}
            numberOfLines={1}
          >
            {label}
          </Text>
          {badge != null && badge > 0 && (
            <Badge variant="subtle" color="default" content={badge} size="small" />
          )}
        </>
      )}
    </TouchableOpacity>
  );
}

export function MailboxDrawer({ onClose, onToggle, collapsed }: { onClose?: () => void; onToggle?: () => void; collapsed?: boolean }) {
  const colors = useColors();
  const { user, isAuthenticated } = useOxy();
  const router = useRouter();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();

  const resetInboxForAccountChange = useCallback(() => {
    useEmailStore.getState().resetAccountScopedState();
    queryClient.clear();
    void clearPersistedInboxCache();
    queryClient.removeQueries({ queryKey: emailKeys.mailboxes.root });
    queryClient.removeQueries({ queryKey: emailKeys.labels });
    queryClient.removeQueries({ queryKey: emailKeys.messages.root });
    queryClient.removeQueries({ queryKey: emailKeys.message.root });
  }, [queryClient]);

  const handleAddAccount = useCallback(() => {
    // Open the sign-in modal to authenticate a new account. OxyContext picks up
    // the new session and ProfileButton's menu reflects it.
    resetInboxForAccountChange();
    openAccountDialog('signin');
  }, [resetInboxForAccountChange]);

  const handleNavigateManage = useCallback(() => {
    router.push('/settings');
    onClose?.();
  }, [router, onClose]);

  const pathname = usePathname();
  const moreExpanded = useEmailStore((s) => s.moreExpanded);
  const toggleMore = useEmailStore((s) => s.toggleMore);
  const { data: mailboxes = [] } = useMailboxes();
  const { data: labels = [] } = useLabels();

  const activeUserId = user?.id ?? null;
  const previousUserIdRef = useRef<string | null>(activeUserId);

  useEffect(() => {
    if (previousUserIdRef.current === activeUserId) {
      return;
    }
    previousUserIdRef.current = activeUserId;
    resetInboxForAccountChange();
  }, [activeUserId, resetInboxForAccountChange]);

  // Determine active state from URL pathname.
  // Path shapes we care about here:
  //   /                → inbox (the app's root view)
  //   /<view>          → system mailbox (sent, drafts, etc.)
  //   /label/<name>    → label view (owned by app/.../label/[name].tsx)
  const pathSegments = useMemo(() => pathname.split('/').filter(Boolean), [pathname]);
  const isLabelRoute = pathSegments[0]?.toLowerCase() === 'label';
  const activeLabelName = isLabelRoute ? pathSegments[1]?.toLowerCase() ?? null : null;
  const currentView = isLabelRoute ? 'label' : pathSegments[0]?.toLowerCase() || 'inbox';

  const { primaryMailboxes, snoozedMailbox, secondaryMailboxes, customFolders } = useMemo(() => {
    const order: Record<string, number> = {
      [SPECIAL_USE.INBOX]: 0, [SPECIAL_USE.SENT]: 1, [SPECIAL_USE.DRAFTS]: 2,
      [SPECIAL_USE.SNOOZED]: 3, [SPECIAL_USE.SPAM]: 4, [SPECIAL_USE.TRASH]: 5, [SPECIAL_USE.ARCHIVE]: 6,
    };
    const sorted = mailboxes
      .filter((m): m is Mailbox & { specialUse: string } => Boolean(m.specialUse))
      .sort((a, b) => (order[a.specialUse] ?? 99) - (order[b.specialUse] ?? 99));

    return {
      primaryMailboxes: sorted.filter((m) => PRIMARY_SPECIAL_USE.has(m.specialUse)),
      snoozedMailbox: sorted.find((m) => m.specialUse === SPECIAL_USE.SNOOZED) ?? null,
      secondaryMailboxes: sorted.filter(
        (m) => !PRIMARY_SPECIAL_USE.has(m.specialUse) && m.specialUse !== SPECIAL_USE.SNOOZED,
      ),
      // User-created folders have no specialUse. They are addressable via the
      // `[view]` route using the mailbox id as the segment.
      customFolders: mailboxes
        .filter((m) => !m.specialUse)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [mailboxes]);

  // Custom-folder create / delete flows.
  const createMailbox = useCreateMailbox();
  const deleteMailbox = useDeleteMailbox();
  const createFolderControl = useDialogControl();
  const deleteFolderControl = useDialogControl();
  const [newFolderName, setNewFolderName] = useState('');
  const [folderPendingDelete, setFolderPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const handleCustomFolderSelect = useCallback(
    (mailbox: Mailbox) => {
      router.push({ pathname: '/(drawer)/(tabs)/(inbox)/[view]', params: { view: mailbox._id } });
      onClose?.();
    },
    [router, onClose],
  );

  const handleCreateFolder = useCallback(() => {
    const name = newFolderName.trim();
    if (!name) return;
    createMailbox.mutate(
      { name },
      {
        onSuccess: () => {
          setNewFolderName('');
          createFolderControl.close();
        },
      },
    );
  }, [newFolderName, createMailbox, createFolderControl]);

  const handleConfirmDeleteFolder = useCallback(() => {
    if (!folderPendingDelete) return;
    deleteMailbox.mutate(
      { mailboxId: folderPendingDelete.id },
      { onSettled: () => setFolderPendingDelete(null) },
    );
  }, [folderPendingDelete, deleteMailbox]);

  const handleSelect = useCallback(
    (mailbox: Mailbox & { specialUse: string }) => {
      // The inbox is the root view, so it is addressed as `/`, not `/inbox`.
      if (mailbox.specialUse === SPECIAL_USE.INBOX) {
        router.push('/');
        onClose?.();
        return;
      }
      const viewMap: Record<string, 'sent' | 'drafts' | 'trash' | 'spam' | 'archive' | 'snoozed'> = {
        [SPECIAL_USE.SENT]: 'sent',
        [SPECIAL_USE.DRAFTS]: 'drafts',
        [SPECIAL_USE.TRASH]: 'trash',
        [SPECIAL_USE.SPAM]: 'spam',
        [SPECIAL_USE.ARCHIVE]: 'archive',
        [SPECIAL_USE.SNOOZED]: 'snoozed',
      };
      const view = viewMap[mailbox.specialUse];
      if (!view) return;
      router.push({ pathname: '/(drawer)/(tabs)/(inbox)/[view]', params: { view } });
      onClose?.();
    },
    [router, onClose],
  );

  const handleStarred = useCallback(() => {
    router.push({ pathname: '/(drawer)/(tabs)/(inbox)/[view]', params: { view: 'starred' } });
    onClose?.();
  }, [router, onClose]);

  const handleLabelSelect = useCallback(
    (labelName: string) => {
      router.push({
        pathname: '/(drawer)/(tabs)/(inbox)/label/[name]',
        params: { name: labelName.toLowerCase() },
      });
      onClose?.();
    },
    [router, onClose],
  );

  const handleCompose = useCallback(() => {
    router.push('/compose');
    onClose?.();
  }, [router, onClose]);

  const handleSubscriptions = useCallback(() => {
    router.push('/subscriptions');
    onClose?.();
  }, [router, onClose]);

  // Real email from the active session's user. Never synthesize `username@oxy.so`.
  // When the user has no email on record, fall back to the `@username` handle.
  // Shown in the header; the footer identity is owned by `ProfileButton`.
  const emailAddress = user?.email || (user?.username ? `@${user.username}` : '');

  // Check if a mailbox route is active
  const isMailboxActive = useCallback(
    (mailbox: Mailbox & { specialUse: string }): boolean => {
      const routeMap: Record<string, string> = {
        [SPECIAL_USE.INBOX]: 'inbox',
        [SPECIAL_USE.SENT]: 'sent',
        [SPECIAL_USE.DRAFTS]: 'drafts',
        [SPECIAL_USE.TRASH]: 'trash',
        [SPECIAL_USE.SPAM]: 'spam',
        [SPECIAL_USE.ARCHIVE]: 'archive',
        [SPECIAL_USE.SNOOZED]: 'snoozed',
      };
      return currentView === routeMap[mailbox.specialUse];
    },
    [currentView],
  );

  const isStarredActive = currentView === 'starred';
  const isSubscriptionsActive = currentView === 'subscriptions';

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.sidebarBackground,
          // Safe-area: respect the top notch / status bar, the home indicator
          // (bottom), and the leading notch on landscape devices. `insets.*`
          // is 0 on web so this is safe to apply unconditionally.
          paddingTop: insets.top + 16,
          paddingLeft: insets.left,
        },
        collapsed && styles.containerCollapsed,
      ]}
    >
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }, collapsed && styles.headerCollapsed]}>
        {collapsed ? (
          <TouchableOpacity
            accessibilityLabel="Expand sidebar"
            accessibilityRole="button"
            onPress={onToggle}
            style={styles.collapseButtonCenter}
            activeOpacity={0.7}
          >
            {Platform.OS === 'web' ? (
              <HugeiconsIcon icon={SidebarRight01Icon as unknown as IconSvgElement} size={20} color={colors.icon} />
            ) : (
              <MaterialCommunityIcons name="dock-right" size={20} color={colors.icon} />
            )}
          </TouchableOpacity>
        ) : (
          <>
            <View style={styles.headerRow}>
              <View style={styles.logoRow}>
                <LogoIcon height={44} color={colors.primary} />
                <Text style={[styles.appTitle, { color: colors.primary }]}>Inbox</Text>
              </View>
              {onToggle && (
                <TouchableOpacity
                  accessibilityLabel="Collapse sidebar"
                  accessibilityRole="button"
                  onPress={onToggle}
                  style={styles.collapseButton}
                  activeOpacity={0.7}
                >
                  {Platform.OS === 'web' ? (
                    <HugeiconsIcon icon={SidebarLeft01Icon as unknown as IconSvgElement} size={20} color={colors.icon} />
                  ) : (
                    <MaterialCommunityIcons name="dock-left" size={20} color={colors.icon} />
                  )}
                </TouchableOpacity>
              )}
            </View>
            <Text style={[styles.email, { color: colors.secondaryText }]}>{emailAddress}</Text>
          </>
        )}
      </View>

      {/* Compose button — auth required */}
      {isAuthenticated && !collapsed && (
        <View style={styles.composeWrapper}>
          <TouchableOpacity
            accessibilityLabel="Compose new email"
            accessibilityRole="button"
            style={[styles.composeButton, { backgroundColor: colors.composeFab }]}
            onPress={handleCompose}
            activeOpacity={0.8}
          >
            {Platform.OS === 'web' ? (
              <HugeiconsIcon icon={PencilEdit01Icon as unknown as IconSvgElement} size={20} color={colors.composeFabIcon} />
            ) : (
              <MaterialCommunityIcons name="pencil" size={20} color={colors.composeFabIcon} />
            )}
            <Text style={[styles.composeLabel, { color: colors.composeFabText }]}>Compose</Text>
          </TouchableOpacity>
        </View>
      )}
      {isAuthenticated && collapsed && (
        <View style={styles.composeWrapperCollapsed}>
          <TouchableOpacity
            accessibilityLabel="Compose new email"
            accessibilityRole="button"
            style={[styles.composeButtonCollapsed, { backgroundColor: colors.composeFab }]}
            onPress={handleCompose}
            activeOpacity={0.8}
          >
            {Platform.OS === 'web' ? (
              <HugeiconsIcon icon={PencilEdit01Icon as unknown as IconSvgElement} size={20} color={colors.composeFabIcon} />
            ) : (
              <MaterialCommunityIcons name="pencil" size={20} color={colors.composeFabIcon} />
            )}
          </TouchableOpacity>
        </View>
      )}

      {/*
       * Search is intentionally not duplicated here — the inbox header
       * (`SearchHeader.tsx`) already exposes a search entry point. Keeping
       * one canonical search affordance avoids two-way bouncing between the
       * drawer and the list and keeps the sidebar tight.
       */}

      {isAuthenticated ? (
        <ScrollView style={[styles.list, collapsed && styles.listCollapsed]} showsVerticalScrollIndicator={false}>

          {/* Primary Mailboxes (Inbox, Sent, Drafts) */}
          {primaryMailboxes.map((mailbox) => {
            const label = mailbox.specialUse.replace(/^\\+/, '');
            const hasUnseen = mailbox.unseenMessages > 0;
            return (
              <NavItem
                key={mailbox._id}
                icon={getMailboxFallbackIcon(mailbox)}
                hugeIcon={getMailboxHugeIcon(mailbox)}
                label={label}
                isActive={isMailboxActive(mailbox)}
                colors={colors}
                badge={mailbox.unseenMessages}
                bold={hasUnseen}
                collapsed={collapsed}
                onPress={() => handleSelect(mailbox)}
              />
            );
          })}

          {/* Starred */}
          <NavItem
            icon="star-outline"
            hugeIcon={HugeStarIcon as unknown as IconSvgElement}
            label="Starred"
            isActive={isStarredActive}
            colors={colors}
            collapsed={collapsed}
            onPress={handleStarred}
          />

          {/* Snoozed */}
          {snoozedMailbox && (
            <NavItem
              icon="clock-outline"
              hugeIcon={Clock01Icon as unknown as IconSvgElement}
              label="Snoozed"
              isActive={isMailboxActive(snoozedMailbox)}
              colors={colors}
              badge={snoozedMailbox.unseenMessages}
              collapsed={collapsed}
              onPress={() => handleSelect(snoozedMailbox)}
            />
          )}

          {/* Subscriptions */}
          <NavItem
            icon="newspaper-variant-outline"
            hugeIcon={Mail01Icon as unknown as IconSvgElement}
            label="Subscriptions"
            isActive={isSubscriptionsActive}
            colors={colors}
            collapsed={collapsed}
            onPress={handleSubscriptions}
          />

          {/* More toggle for secondary mailboxes */}
          {secondaryMailboxes.length > 0 && !collapsed && (
            <TouchableOpacity style={styles.moreToggle} onPress={toggleMore} activeOpacity={0.7}>
              {Platform.OS === 'web' ? (
                <HugeiconsIcon
                  icon={(moreExpanded ? ArrowUp01Icon : ArrowDown01Icon) as unknown as IconSvgElement}
                  size={16}
                  color={colors.secondaryText}
                />
              ) : (
                <MaterialCommunityIcons
                  name={moreExpanded ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={colors.secondaryText}
                />
              )}
              <Text style={[styles.moreToggleText, { color: colors.secondaryText }]}>
                {moreExpanded ? 'Less' : 'More'}
              </Text>
            </TouchableOpacity>
          )}

          {/* Secondary Mailboxes (Spam, Trash, Archive) - behind "More" */}
          {(moreExpanded || collapsed) && secondaryMailboxes.map((mailbox) => {
            const label = mailbox.specialUse.replace(/^\\+/, '');
            return (
              <NavItem
                key={mailbox._id}
                icon={getMailboxFallbackIcon(mailbox)}
                hugeIcon={getMailboxHugeIcon(mailbox)}
                label={label}
                isActive={isMailboxActive(mailbox)}
                colors={colors}
                badge={mailbox.unseenMessages}
                collapsed={collapsed}
                onPress={() => handleSelect(mailbox)}
              />
            );
          })}

          {/* Labels (from Label model, not custom mailboxes) */}
          {!collapsed && labels.length > 0 && (
            <>
              <Divider />
              <Text style={[styles.sectionTitle, { color: colors.secondaryText }]}>Labels</Text>
              {labels.map((lbl) => (
                <NavItem
                  key={lbl._id}
                  icon="label-outline"
                  hugeIcon={LabelIcon as unknown as IconSvgElement}
                  label={lbl.name}
                  isActive={activeLabelName === lbl.name.toLowerCase()}
                  colors={colors}
                  colorDot={lbl.color}
                  collapsed={collapsed}
                  onPress={() => handleLabelSelect(lbl.name)}
                />
              ))}
            </>
          )}
          {/* Labels hidden when collapsed for cleaner UI */}

          {/* Custom folders — addressable via the [view] route (view = mailbox id) */}
          {!collapsed && (
            <>
              <Divider />
              <View style={styles.foldersHeaderRow}>
                <Text style={[styles.sectionTitle, { color: colors.secondaryText }]}>Folders</Text>
                <TouchableOpacity
                  accessibilityLabel="Create folder"
                  accessibilityRole="button"
                  onPress={() => createFolderControl.open()}
                  style={styles.folderAddButton}
                  activeOpacity={0.7}
                >
                  {Platform.OS === 'web' ? (
                    <HugeiconsIcon icon={Add01Icon as unknown as IconSvgElement} size={16} color={colors.icon} />
                  ) : (
                    <MaterialCommunityIcons name="plus" size={16} color={colors.icon} />
                  )}
                </TouchableOpacity>
              </View>
              {customFolders.map((folder) => (
                <NavItem
                  key={folder._id}
                  icon="folder-outline"
                  hugeIcon={Folder01Icon as unknown as IconSvgElement}
                  label={folder.name}
                  isActive={currentView === folder._id.toLowerCase()}
                  colors={colors}
                  badge={folder.unseenMessages}
                  onPress={() => handleCustomFolderSelect(folder)}
                  onLongPress={() => {
                    setFolderPendingDelete({ id: folder._id, name: folder.name });
                    deleteFolderControl.open();
                  }}
                />
              ))}
              {customFolders.length === 0 && (
                <Text style={[styles.foldersHint, { color: colors.secondaryText }]}>
                  Tap + to create a folder. Long-press a folder to delete it.
                </Text>
              )}
            </>
          )}
        </ScrollView>
      ) : (
        <View style={[styles.list, collapsed && styles.listCollapsed, styles.signedOutBody]}>
          {!collapsed && (
            <View style={styles.signedOutCard}>
              <View style={[styles.signedOutIconCircle, { backgroundColor: colors.primaryContainer }]}>
                {Platform.OS === 'web' ? (
                  <HugeiconsIcon icon={Mail01Icon as unknown as IconSvgElement} size={28} color={colors.primary} />
                ) : (
                  <MaterialCommunityIcons name="email-outline" size={28} color={colors.primary} />
                )}
              </View>
              <Text style={[styles.signedOutTitle, { color: colors.text }]}>
                Sign in to manage your email
              </Text>
              <Text style={[styles.signedOutSubtitle, { color: colors.secondaryText }]}>
                Access your mailboxes, labels, and compose new messages.
              </Text>
              <OxySignInButton variant="contained" style={styles.signedOutCta} />
            </View>
          )}
        </View>
      )}

      {/*
       * Account section at bottom — only rendered when signed-in. When the
       * user is signed-out the centered sign-in card above is the single
       * primary CTA; the footer drops to a thin "Not signed in" label so we
       * don't duplicate the action. Bottom inset is respected so the row
       * isn't clipped by the home indicator / Android gesture area.
       */}
      {!collapsed && isAuthenticated && (
        <View
          style={[
            styles.footer,
            { borderTopColor: colors.border, paddingBottom: insets.bottom + 8 },
          ]}
        >
          <ProfileButton
            expanded
            avatarSize={32}
            onNavigateManage={handleNavigateManage}
            onAddAccount={handleAddAccount}
          />
        </View>
      )}

      {!collapsed && !isAuthenticated && (
        <View
          style={[
            styles.footer,
            styles.footerSignedOut,
            { borderTopColor: colors.border, paddingBottom: insets.bottom + 8 },
          ]}
        >
          <Text style={[styles.footerSignedOutLabel, { color: colors.secondaryText }]}>
            Not signed in
          </Text>
        </View>
      )}

      {/* Collapsed footer — avatar (signed-in) or empty (signed-out keeps it clean) */}
      {collapsed && isAuthenticated && (
        <View
          style={[
            styles.footer,
            styles.collapsedFooter,
            { borderTopColor: colors.border, paddingBottom: insets.bottom + 8 },
          ]}
        >
          <ProfileButton
            expanded={false}
            avatarSize={32}
            onNavigateManage={handleNavigateManage}
            onAddAccount={handleAddAccount}
          />
        </View>
      )}

      {/* Create folder */}
      <Dialog control={createFolderControl} title="New folder" label="New folder">
        <View style={styles.folderDialogBody}>
          <TextInput
            value={newFolderName}
            onChangeText={setNewFolderName}
            placeholder="Folder name"
            placeholderTextColor={colors.secondaryText}
            autoFocus
            onSubmitEditing={handleCreateFolder}
            returnKeyType="done"
            style={[styles.folderDialogInput, { color: colors.text, borderColor: colors.border }]}
          />
          <Button
            onPress={handleCreateFolder}
            disabled={!newFolderName.trim() || createMailbox.isPending}
          >
            {createMailbox.isPending ? 'Creating…' : 'Create folder'}
          </Button>
        </View>
      </Dialog>

      {/* Delete folder confirmation */}
      <Dialog
        control={deleteFolderControl}
        title="Delete folder?"
        description={
          folderPendingDelete
            ? `"${folderPendingDelete.name}" and its organization will be removed. Messages inside are not deleted.`
            : ''
        }
        actions={[
          { label: 'Delete', color: 'destructive', onPress: handleConfirmDeleteFolder },
          { label: 'Cancel', color: 'cancel' },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    // paddingTop is applied at the call site via insets.top + 16.
  },
  containerCollapsed: {
    alignItems: 'center',
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
  },
  headerCollapsed: {
    paddingHorizontal: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logoRow: {
    alignItems: 'flex-start',
    gap: 4,
  },
  appTitle: {
    fontSize: 24,
    fontWeight: '800',
  },
  collapseButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  collapseButtonCenter: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  email: {
    fontSize: 12,
  },
  composeWrapper: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  composeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    paddingVertical: 14,
    paddingHorizontal: 24,
    gap: 10,
  },
  composeLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  composeWrapperCollapsed: {
    paddingVertical: 8,
    alignItems: 'center',
  },
  composeButtonCollapsed: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchWrapper: {
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  searchButton: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 14,
    gap: 10,
  },
  searchLabel: {
    fontSize: 14,
    flex: 1,
  },
  list: {
    flex: 1,
    paddingHorizontal: 8,
  },
  listCollapsed: {
    paddingHorizontal: 4,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 28,
    marginVertical: 1,
    gap: 12,
  },
  itemCollapsed: {
    justifyContent: 'center',
    padding: 10,
    borderRadius: 12,
    gap: 0,
  },
  itemLabel: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
  },
  itemLabelActive: {
    fontWeight: '700',
  },
  colorDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  moreToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    gap: 8,
  },
  moreToggleText: {
    fontSize: 12,
    fontWeight: '600',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    paddingHorizontal: 14,
    paddingVertical: 6,
    letterSpacing: 0.5,
  },
  foldersHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 8,
  },
  folderAddButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  foldersHint: {
    fontSize: 12,
    paddingHorizontal: 14,
    paddingVertical: 4,
    lineHeight: 16,
  },
  folderDialogBody: {
    gap: 12,
    paddingTop: 8,
    minWidth: 260,
  },
  folderDialogInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  signedOutBody: {
    paddingHorizontal: 16,
    paddingTop: 24,
  },
  signedOutCard: {
    alignItems: 'center',
    paddingVertical: 24,
    paddingHorizontal: 16,
    gap: 12,
  },
  signedOutIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  signedOutTitle: {
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  signedOutSubtitle: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 8,
  },
  signedOutCta: {
    alignSelf: 'stretch',
  },
  footerSignedOut: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerSignedOutLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  collapsedFooter: {
    alignItems: 'center',
  },
});
