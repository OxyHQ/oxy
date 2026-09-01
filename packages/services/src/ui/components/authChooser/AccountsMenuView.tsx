/**
 * The signed-in Oxy account MENU (`accounts` view) — a Google-account-menu-style
 * full menu built entirely with NativeWind `className` (the dynamic per-account
 * accent hex is the one inline style NativeWind cannot express). Structure:
 *
 *  - HERO on its own chrome-free block: the current account's large pressable
 *    avatar (with a camera badge to change the photo), the greeting, the account
 *    address, and a "Manage your Oxy account" pill.
 *  - SWITCH ACCOUNT: a disclosure row whose corner animates from pill to card as
 *    the other switchable accounts + "Add another account" + "Manage accounts on
 *    this device" reveal beneath it.
 *  - OXY STORAGE: cloud + used/total + a composition meter + Upgrade / Manage chips.
 *  - MENU rows: Your data in Oxy · Oxy settings · Help & feedback · Sign out —
 *    Bloom's grouped section, the same component every other SDK settings surface
 *    uses, not a local row copy.
 *  - FOOTER: Privacy Policy · Terms of Service.
 *
 * All three blocks share ONE rhythm taken from that grouped section: a 12px
 * content inset, a 12px gap after the leading element, 16px between blocks, and
 * a 16px trailing chevron column.
 *
 * Collapse state is a plain `useState` toggled in the row's press handler — no
 * effect hook, no derived-from-props sync.
 */

import type React from 'react';
import { Fragment, useCallback, useState } from 'react';
import { Pressable, View } from 'react-native-css/components';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Avatar } from '@oxyhq/bloom/avatar';
import { AvatarGroup, type AvatarGroupItem } from '@oxyhq/bloom/avatar-group';
import { Button } from '@oxyhq/bloom/button';
import { PressableScale } from '@oxyhq/bloom/pressable-scale';
import { CompositionBar, type CompositionCategory } from '@oxyhq/bloom/composition-bar';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { Text } from '@oxyhq/bloom/typography';
import type { AccountDialogSnapshot, SwitchableAccount } from '@oxyhq/core';
import { getNormalizedUserHandle } from '@oxyhq/core';
import AvatarCameraBadge from '../AvatarCameraBadge';
import { HoverPressable } from './primitives';
import { authChooserStyles as styles } from './styles';
import {
  resolveAccentHex,
  type AccountStorageModel,
  type AccountsMenuActions,
  type OxyAuthChooserHandlers,
  type Theme,
  type Translate,
} from './types';

/**
 * Leading glyph for the rows that live in a Bloom grouped section (the MENU
 * block) and for the storage card's cloud, which lines its title up with them.
 * It is Bloom's OWN icon-slot size: `SettingsListItem` reserves a fixed 20px
 * leading column and Bloom is consumed exactly as it ships, so a menu glyph
 * larger than this would overhang into the row's title.
 */
const ROW_ICON_SIZE = 20;
/**
 * The switch card's two corner states. Collapsed it is one row and reads as a
 * PILL; opened it is a card holding rows, on the same 16px corner the Bloom
 * grouped section below it uses. Interpolated across the reveal, never snapped.
 */
const SWITCH_CARD_PILL_RADIUS = 999;
const SWITCH_CARD_RADIUS = 16;
/**
 * The fraction of the reveal over which the corner resolves. The corner is a
 * FASTER gesture than the reveal — it has to be finished before the rows read as
 * rows, or the card still looks like a pill while a list falls out of it — so it
 * is clamped to the reveal's opening fraction instead of tracking it end to end.
 * Measured in a browser against the 240ms reveal: the corner reaches its card
 * value ~120ms in, with the list only ~20% revealed, and (mirrored) the pill is
 * back ~250ms into the close, with the list already down to ~0.
 */
const SWITCH_CARD_RADIUS_SETTLE = 0.2;
/** Duration of the switch-list reveal. */
const SWITCH_REVEAL_MS = 240;
/** Diameter of an account row's avatar in the switch list (own markup). */
const SWITCH_AVATAR_SIZE = 36;
/** Glyph inside a bordered affordance badge, sized to the avatar it stands in for. */
const BADGE_GLYPH_SIZE = 19;
/** The hero block's large current-account avatar. */
const HERO_AVATAR_SIZE = 72;
/** Avatars shown in the switch row's facepile before it collapses into `+N`. */
const FACEPILE_MAX = 2;
/** Facepile avatar diameter — one clear step down from a switch-list avatar. */
const FACEPILE_AVATAR_SIZE = 32;
/**
 * Facepile overlap. Well under Bloom's `size / 3` default: the stack draws the
 * FIRST item on top, so a deep overlap would bury the trailing `+N` chip's own
 * label under the avatar before it.
 */
const FACEPILE_OVERLAP = 4;


/**
 * The hero's address line, shown under the "Hi, <name>!" greeting: the account's
 * canonical `@oxy.so` email when it has one, else its normalized `@handle`. Never
 * synthesizes a `username@oxy.so` address (the identity contract forbids it) — a
 * non-Oxy or missing email falls back to `getNormalizedUserHandle`.
 */
function heroAddressLine(account: SwitchableAccount): string | null {
  if (account.email?.toLowerCase().endsWith('@oxy.so')) {
    return account.email;
  }
  const handle = getNormalizedUserHandle(account.user);
  return handle ? `@${handle}` : null;
}

/**
 * `bytes` → `"11.6 GB"`. Whole plan sizes read as whole numbers (`"17 GB"`, not
 * `"17.0 GB"`), and anything ≥ 100 GB drops the decimal entirely.
 */
function formatStorageGb(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 100 || Number.isInteger(gb)) return `${Math.round(gb)} GB`;
  return `${gb.toFixed(1)} GB`;
}

interface AccountsMenuViewProps {
  snapshot: AccountDialogSnapshot;
  theme: Theme;
  t: Translate;
  handlers: OxyAuthChooserHandlers;
  storage: AccountStorageModel | null;
  menu: AccountsMenuActions;
}

const AccountsMenuView: React.FC<AccountsMenuViewProps> = ({
  snapshot,
  theme,
  t,
  handlers,
  storage,
  menu,
}) => {
  const [expanded, setExpanded] = useState(false);
  // Measured natural height of the switch list, so the reveal animates to an
  // exact height (and the content below reflows down smoothly) instead of a
  // guessed max. The measuring wrapper is style-based, NOT className'd — on
  // RN-Web `onLayout` never fires for className'd Views (see AGENTS.md).
  const [listContentHeight, setListContentHeight] = useState(0);
  // 0 = collapsed, 1 = expanded. Set imperatively in the toggle handler (no
  // effect hook). On RN-Web there is no worklets plugin, so every shared value a
  // mapper reads MUST be in its deps array or it freezes on the first frame
  // (AGENTS.md "Reanimated (web)").
  const listProgress = useSharedValue(0);
  const listStyle = useAnimatedStyle(
    () => ({ height: listProgress.value * listContentHeight, opacity: listProgress.value }),
    [listProgress, listContentHeight],
  );
  const chevronStyle = useAnimatedStyle(
    () => ({ transform: [{ rotate: `${listProgress.value * 180}deg` }] }),
    [listProgress],
  );
  // Collapsed, the switch card is a single row and reads as a PILL; opened, it
  // becomes a card holding rows and takes the grouped-section corner. The corner
  // is driven off the SAME `listProgress` as the reveal — but clamped to its
  // opening fraction, so it resolves early instead of trailing the rows.
  const switchCardStyle = useAnimatedStyle(
    () => ({
      borderRadius: interpolate(
        listProgress.value,
        [0, SWITCH_CARD_RADIUS_SETTLE],
        [SWITCH_CARD_PILL_RADIUS, SWITCH_CARD_RADIUS],
        Extrapolation.CLAMP,
      ),
    }),
    [listProgress],
  );
  // `CompositionBar` ships as an interactive breakdown: a selected segment
  // replaces its hint line with that segment's readout. Tapping the selected one
  // again clears it.
  const [storageSegment, setStorageSegment] = useState<string | null>(null);
  const toggleStorageSegment = useCallback(
    (key: string) => setStorageSegment((previous) => (previous === key ? null : key)),
    [],
  );
  const toggleExpanded = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    listProgress.value = withTiming(next ? 1 : 0, { duration: SWITCH_REVEAL_MS });
  }, [expanded, listProgress]);

  if (snapshot.loading && snapshot.accounts.length === 0) {
    return (
      <View className="items-center justify-center gap-space-12 py-space-24">
        <MaterialCommunityIcons name="loading" size={24} color={theme.colors.textSecondary} />
        <Text className="text-body text-text-secondary text-center">
          {t('accountSwitcher.loading')}
        </Text>
      </View>
    );
  }

  const switchingDisabled = snapshot.switchingAccountId !== null;
  const current = snapshot.accounts.find((account) => account.isCurrent) ?? snapshot.accounts[0];
  const others = current
    ? snapshot.accounts.filter((account) => account.accountId !== current.accountId)
    : snapshot.accounts;
  const currentAccent = current
    ? resolveAccentHex(current.color, theme.colors.primary)
    : theme.colors.primary;
  const currentAddress = current ? heroAddressLine(current) : null;
  // The switch list repeats the CURRENT account (first, ringed) — unlike the old
  // compact header it is not represented anywhere else once the hero moved out
  // of the card, and the list is where you switch back to it.
  const switchableAccounts = current ? [current, ...others] : others;
  const facepile: AvatarGroupItem[] = switchableAccounts.map((account) => ({
    id: account.accountId,
    uri: account.avatarUrl ?? undefined,
    displayName: account.displayName,
  }));

  // Used vs free is a two-part COMPOSITION (the parts always fill the bar), not
  // a progress value — exactly what Bloom's `CompositionBar` models. Both colors
  // are theme tokens, so the bar is correct in light and dark.
  const storageCategories: CompositionCategory[] = storage
    ? [
        {
          key: 'used',
          name: t('accountMenu.storage.used'),
          amount: storage.usedBytes,
          color: theme.colors.primary,
        },
        {
          key: 'free',
          name: t('accountMenu.storage.free'),
          amount: Math.max(0, storage.limitBytes - storage.usedBytes),
          color: theme.colors.contrast50,
        },
      ]
    : [];
  const usageLabel = storage
    ? t('accountMenu.storage.usage', {
        used: formatStorageGb(storage.usedBytes),
        total: formatStorageGb(storage.limitBytes),
      })
    : t('accountMenu.storage.unavailable');

  // The switch list body, revealed under the "Switch account" row. Own markup,
  // not a Bloom grouped section: this is not a list of settings rows and the
  // component is not a card container. It mirrors the section's rhythm by hand —
  // 12px content inset, 12px after the avatar, a hairline between rows — and
  // draws those hairlines INSIDE the animated clip, so a collapsed list never
  // strands one against the header row.
  const listItems = (
    <>
      {switchableAccounts.map((account, index) => {
        const accent = resolveAccentHex(account.color, theme.colors.primary);
        const isSwitching = snapshot.switchingAccountId === account.accountId;
        return (
          <Fragment key={account.accountId}>
            {index > 0 ? <View className="h-px bg-border opacity-30 ml-space-12" /> : null}
            <HoverPressable
              baseClassName={`flex-row items-center gap-space-12 px-space-12 py-[10px]${
                switchingDisabled ? ' opacity-60' : ''
              }`}
              hoverClassName="bg-fill-secondary"
              onPress={() => handlers.onSwitch(account.accountId)}
              disabled={switchingDisabled}
              accessibilityRole="button"
              accessibilityLabel={account.displayName}
            >
              <View>
                <Avatar
                  source={account.avatarUrl ?? undefined}
                  variant="thumb"
                  name={account.displayName}
                  size={SWITCH_AVATAR_SIZE}
                />
                {/* The accent ring is an OVERLAY: it costs the row no width, so
                    every avatar in the list starts on the same content line. */}
                {account.isCurrent ? (
                  <View
                    style={[styles.currentAvatarRing, { borderColor: accent }]}
                    pointerEvents="none"
                  />
                ) : null}
              </View>
              <View className="flex-1 min-w-0">
                <Text className="text-body font-semibold text-text" numberOfLines={1}>
                  {account.displayName}
                </Text>
                {account.email ? (
                  <Text className="text-caption text-text-secondary" numberOfLines={1}>
                    {account.email}
                  </Text>
                ) : null}
              </View>
              {isSwitching ? (
                <MaterialCommunityIcons name="loading" size={20} color={accent} />
              ) : null}
            </HoverPressable>
          </Fragment>
        );
      })}

      <View className="h-px bg-border opacity-30 ml-space-12" />
      <AccountAffordanceRow
        icon="plus"
        label={t('accountMenu.addAnother')}
        onPress={handlers.onAdd}
        disabled={switchingDisabled}
        theme={theme}
      />
      <View className="h-px bg-border opacity-30 ml-space-12" />
      <AccountAffordanceRow
        icon="account-multiple-outline"
        label={t('accountSwitcher.manageOnDevice')}
        onPress={handlers.onManage}
        disabled={switchingDisabled}
        theme={theme}
      />
    </>
  );

  const manageLabel = t('accountMenu.manage');
  const switchLabel = t('accountMenu.switchAccount');

  return (
    <View>
      {/* HERO — chrome-free and centred, in the reference's reading order:
          NOTHING above the avatar (the nav bar's Oxy wordmark stands alone), the
          large pressable avatar (with a camera badge to change the photo), then
          the greeting, then the account address under it, then the manage action. */}
      <View style={styles.hero}>
        {current ? (
          <>
            <PressableScale
              onPress={handlers.onEditAvatar}
              accessibilityRole="button"
              accessibilityLabel={t('editProfile.changeAvatar')}
              style={styles.heroAvatarPressable}
            >
              <Avatar
                source={current.avatarUrl ?? undefined}
                name={current.displayName}
                size={HERO_AVATAR_SIZE}
              />
              <View
                style={[styles.heroAvatarRing, { borderColor: currentAccent }]}
                pointerEvents="none"
              />
              <AvatarCameraBadge />
            </PressableScale>
            <View style={styles.heroNameBlock}>
              <Text style={[styles.heroGreeting, { color: theme.colors.text }]} numberOfLines={2}>
                {t('accountMenu.greeting', { name: current.displayName })}
              </Text>
              {currentAddress ? (
                <Text
                  style={[styles.heroAddress, { color: theme.colors.textSecondary }]}
                  numberOfLines={1}
                >
                  {currentAddress}
                </Text>
              ) : null}
            </View>
          </>
        ) : null}
        {/* Bloom's own compact outlined pill — `secondary` is the outlined
            variant, `small` the compact height; it hugs its label instead of
            spanning the surface. */}
        <Button
          variant="secondary"
          size="small"
          onPress={handlers.onManage}
          accessibilityLabel={manageLabel}
        >
          {manageLabel}
        </Button>
      </View>

      {/* SWITCH ACCOUNT — own NativeWind card, NOT a Bloom grouped section: it
          is a disclosure header over an animated list, not a list of settings
          rows, and the grouped section is not a bare card container. */}
      <Animated.View className="bg-fill overflow-hidden mb-space-16" style={switchCardStyle}>
        <HoverPressable
          baseClassName={`flex-row items-center gap-space-12 px-space-12 py-[10px] min-h-[44px]${
            switchingDisabled ? ' opacity-60' : ''
          }`}
          hoverClassName="bg-fill-secondary"
          onPress={toggleExpanded}
          disabled={switchingDisabled}
          accessibilityRole="button"
          // The ARIA prop, not `accessibilityState`: react-native-web 0.21
          // forwards only this one, and RN maps it to
          // `accessibilityState.expanded` natively — so the disclosure state
          // reaches assistive tech on BOTH platforms.
          aria-expanded={expanded}
          accessibilityLabel={switchLabel}
        >
          <Text className="flex-1 text-body text-text" numberOfLines={1}>
            {switchLabel}
          </Text>
          {/* The facepile previews who you can switch to; once the list is open
              it would just restate the rows below it. */}
          {expanded ? null : (
            <AvatarGroup
              items={facepile}
              layout="stack"
              size={FACEPILE_AVATAR_SIZE}
              max={FACEPILE_MAX}
              overlap={FACEPILE_OVERLAP}
              variant="thumb"
              showInitials
              ringColor={theme.colors.card}
            />
          )}
          <View style={[styles.chevronCircle, { backgroundColor: theme.colors.contrast50 }]}>
            <Animated.View style={chevronStyle}>
              <MaterialCommunityIcons name="chevron-down" size={20} color={theme.colors.text} />
            </Animated.View>
          </View>
        </HoverPressable>

        {/* Animated reveal: an overflow-clipped container whose height + opacity
            are driven by `listProgress`; the inner style-based wrapper measures
            the natural content height via `onLayout`. */}
        <Animated.View
          style={[styles.collapse, listStyle]}
          pointerEvents={expanded ? 'auto' : 'none'}
        >
          <View
            style={styles.collapseMeasure}
            onLayout={(event) => setListContentHeight(event.nativeEvent.layout.height)}
          >
            <View>{listItems}</View>
          </View>
        </Animated.View>
      </Animated.View>

      {/* OXY STORAGE — own NativeWind card for the same reason: a title, a meter
          and two chips are not settings rows. Its cloud sits in the same 20px
          column Bloom's own rows use, so the title below lines up with the menu
          titles. */}
      <View className="bg-fill rounded-[16px] overflow-hidden mb-space-16 px-space-12 py-[10px] gap-space-12">
        <View className="flex-row items-center gap-space-12 min-h-[24px]">
          <View className="w-[20px] items-center">
            <MaterialCommunityIcons
              name="cloud-outline"
              size={ROW_ICON_SIZE}
              color={theme.colors.textSecondary}
            />
          </View>
          <Text className="flex-1 text-body font-semibold text-text" numberOfLines={1}>
            {t('accountMenu.storage.title')}
          </Text>
        </View>
        <CompositionBar
          categories={storageCategories}
          selectedKey={storageSegment}
          onSelect={toggleStorageSegment}
          hintLabel={usageLabel}
          formatReadout={(bytes, percent) => `${formatStorageGb(bytes)} · ${percent}%`}
        />
        <View className="flex-row gap-space-8">
          <StorageChip label={t('accountMenu.storage.upgrade')} onPress={menu.onUpgradeStorage} />
          <StorageChip label={t('accountMenu.storage.manage')} onPress={menu.onManageStorage} />
        </View>
      </View>

      {/* MENU — the same stock grouped section. */}
      <SettingsListGroup>
        <SettingsListItem
          icon={<MenuIcon name="tray-arrow-down" theme={theme} />}
          title={t('accountMenu.data')}
          onPress={menu.onOpenData}
        />
        <SettingsListItem
          icon={<MenuIcon name="cog-outline" theme={theme} />}
          title={t('accountMenu.settings')}
          onPress={menu.onOpenSettings}
        />
        <SettingsListItem
          icon={<MenuIcon name="help-circle-outline" theme={theme} />}
          title={t('accountMenu.help')}
          onPress={menu.onHelp}
        />
        <SettingsListItem
          icon={<MenuIcon name="logout" theme={theme} />}
          title={t('accountMenu.signOut')}
          onPress={menu.onSignOut}
          showChevron={false}
        />
      </SettingsListGroup>

      {/* FOOTER. */}
      <View className="flex-row items-center justify-center gap-space-12 px-space-12 pb-space-8">
        <Pressable onPress={menu.onPrivacy} accessibilityRole="link">
          <Text className="text-bodySmall text-text-secondary">{t('accountMenu.privacy')}</Text>
        </Pressable>
        <Text className="text-bodySmall text-text-tertiary">·</Text>
        <Pressable onPress={menu.onTerms} accessibilityRole="link">
          <Text className="text-bodySmall text-text-secondary">{t('accountMenu.terms')}</Text>
        </Pressable>
      </View>
    </View>
  );
};

/**
 * An account-list AFFORDANCE row ("Add another account", "Manage accounts on
 * this device") — a bordered circle sized to the avatar it stands in for, so its
 * label lands on the same line as every account name above it. Own markup, like
 * the account rows it closes: this list is not a Bloom grouped section.
 */
const AccountAffordanceRow: React.FC<{
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  theme: Theme;
}> = ({ icon, label, onPress, disabled, theme }) => (
  <HoverPressable
    baseClassName={`flex-row items-center gap-space-12 px-space-12 py-[10px]${
      disabled ? ' opacity-60' : ''
    }`}
    hoverClassName="bg-fill-secondary"
    onPress={onPress}
    disabled={disabled}
    accessibilityRole="button"
    accessibilityLabel={label}
  >
    <View className="w-[36px] h-[36px] items-center justify-center rounded-radius-max border border-border">
      <MaterialCommunityIcons
        name={icon}
        size={BADGE_GLYPH_SIZE}
        color={theme.colors.textSecondary}
      />
    </View>
    <Text className="flex-1 text-body font-semibold text-text" numberOfLines={1}>
      {label}
    </Text>
  </HoverPressable>
);

/**
 * The leading glyph for a grouped-section menu row, sized to Bloom's 20px icon
 * column so the icons, the storage block's cloud and every row title align.
 */
const MenuIcon: React.FC<{
  name: keyof typeof MaterialCommunityIcons.glyphMap;
  theme: Theme;
}> = ({ name, theme }) => (
  <MaterialCommunityIcons name={name} size={ROW_ICON_SIZE} color={theme.colors.textSecondary} />
);

/** A storage action chip — a bordered pill on the sheet background. */
const StorageChip: React.FC<{ label: string; onPress: () => void }> = ({ label, onPress }) => (
  <HoverPressable
    baseClassName="rounded-radius-max border border-border bg-bg py-[9px] px-[14px]"
    hoverClassName="bg-fill-secondary"
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={label}
  >
    <Text className="text-bodySmall font-semibold text-text">{label}</Text>
  </HoverPressable>
);

export default AccountsMenuView;
