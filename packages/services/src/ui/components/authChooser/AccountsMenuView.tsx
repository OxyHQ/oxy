import { SpinnerIcon } from '@oxy.so/bloom/loading';
import type React from 'react';
import { useCallback, useState } from 'react';
import { View } from 'react-native-css/components';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import MaterialCommunityIcons from '../../icons/MaterialCommunityIcons';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { RiSparklingFill } from '@oxy.so/bloom/icons/RiSparklingFill';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { UsageCard } from '@oxy.so/bloom/usage-card';
import {
  GroupedSection,
  GroupedSectionItem,
  GroupedSectionCollapse,
  GroupedSectionIcon,
} from '@oxy.so/bloom/grouped-section';
import { Text } from '@oxy.so/bloom/typography';
import {
  showsPrincipalHeaders,
  type AccountDialogSnapshot,
  type SwitcherContextRow,
  type SwitcherPrincipalRow,
} from '@oxy.so/core/session';
import AvatarCameraBadge from '../AvatarCameraBadge';
import LogoIcon from '../logo/LogoIcon';
import { authChooserStyles as styles } from './styles';
import { accountStorageUsage, formatStorageSize, shouldShowStorageActions } from './storageUsage';
import {
  resolveAccentHex,
  type AccountHeroModel,
  type AccountStorageModel,
  type AccountsMenuActions,
  type OxyAuthChooserHandlers,
  type Theme,
  type Translate,
} from './types';

/** Duration of the disclosure chevron rotation. */
const SWITCH_REVEAL_MS = 240;
/** Diameter of an account row's avatar in the switch list (own markup). */
const SWITCH_AVATAR_SIZE = 36;
/**
 * The person's avatar above their block of accounts. Smaller than the account
 * rows beneath it: the header labels the group, the rows are the targets.
 */
const PRINCIPAL_AVATAR_SIZE = 24;
/** Current-account avatar in the summary row. */
const HERO_AVATAR_SIZE = 56;
interface AccountsMenuViewProps {
  snapshot: Pick<
    AccountDialogSnapshot,
    'loading' | 'activatingContextId' | 'removingContextId' | 'removingPrincipalId'
  >;
  /** The device's people, each with the accounts they may act as. */
  principals: SwitcherPrincipalRow[];
  /** The current account in the summary row. `null` before the session resolves. */
  hero: AccountHeroModel | null;
  theme: Theme;
  t: Translate;
  handlers: OxyAuthChooserHandlers;
  storage: AccountStorageModel | null;
  menu: AccountsMenuActions;
}

const AccountsMenuView: React.FC<AccountsMenuViewProps> = ({
  snapshot,
  principals,
  hero,
  theme,
  t,
  handlers,
  storage,
  menu,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [summaryHovered, setSummaryHovered] = useState(false);
  // Bloom owns the grouped surface; the dialog owns measured size transitions.
  const listProgress = useSharedValue(0);
  const chevronStyle = useAnimatedStyle(
    () => ({ transform: [{ rotate: `${listProgress.value * 180}deg` }] }),
    [listProgress],
  );
  const toggleExpanded = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    listProgress.value = withTiming(next ? 1 : 0, { duration: SWITCH_REVEAL_MS });
  }, [expanded, listProgress]);

  // Activation and the two removals all mutate the same device, so any one of
  // them in flight disables every row: a second press would race the first for
  // which context the server ends up electing as active.
  const busy =
    snapshot.activatingContextId !== null ||
    snapshot.removingContextId !== null ||
    snapshot.removingPrincipalId !== null;
  // Naming the person above each block earns its place only when the grouping
  // carries information — a second person, or somebody with more than one
  // account. On a one-person, one-account device it would just repeat the hero.
  const showPrincipalHeaders = showsPrincipalHeaders(principals);

  // Direct children share Bloom's grouped shape and spacing. Keep the
  // principal/context pair as the action identity, even for shared accounts.
  const listItems = principals.flatMap((principal) => [
    ...(showPrincipalHeaders
      ? [
          <PrincipalHeaderRow
            key={`principal:${principal.principalId}`}
            principal={principal}
            removing={snapshot.removingPrincipalId === principal.principalId}
            disabled={busy}
            onSignOut={() => handlers.onRemovePrincipal(principal.principalId)}
            theme={theme}
            t={t}
          />,
        ]
      : []),
    ...principal.contexts
      .filter((context) => !context.isActive)
      .map((context) => (
        <ContextRow
          key={context.contextId}
          context={context}
          principalName={principal.displayName}
          accent={resolveAccentHex(context.color, theme.colors.primary)}
          activating={snapshot.activatingContextId === context.contextId}
          removing={snapshot.removingContextId === context.contextId}
          disabled={busy}
          onActivate={() => handlers.onActivate(context.contextId)}
          onRemove={() => handlers.onRemoveContext(context.contextId)}
          theme={theme}
          t={t}
        />
      )),
  ]);

  const manageLabel = t('accountMenu.manage');
  const switchLabel = t('accountMenu.switchAccount');

  return (
    <View>
      {/* The active account is also the switcher disclosure. Avatar editing is
          a sibling button, so it never toggles the list or nests a button. */}
      <GroupedSection style={styles.menuGroup}>
        <View
          testID="account-summary"
          onPointerEnter={() => setSummaryHovered(true)}
          onPointerLeave={() => setSummaryHovered(false)}
          style={[
            styles.accountSummary,
            summaryHovered && !busy && { backgroundColor: theme.colors.contrast50 },
          ]}
        >
          {hero ? (
            <PressableScale
              onPress={handlers.onEditAvatar}
              accessibilityRole="button"
              accessibilityLabel={t('editProfile.changeAvatar')}
              style={styles.accountAvatar}
            >
              <Avatar
                source={hero.avatarUrl ?? undefined}
                name={hero.displayName}
                size={HERO_AVATAR_SIZE}
              />
              <AvatarCameraBadge />
            </PressableScale>
          ) : null}
          <PressableScale
            className={`flex-1 min-w-0 flex-row items-center gap-space-12 py-space-12${busy ? ' opacity-60' : ''}`}
            onPress={toggleExpanded}
            disabled={busy}
            accessibilityRole="button"
            aria-expanded={expanded}
            accessibilityLabel={switchLabel}
          >
            <View style={styles.accountIdentity}>
              <Text style={[styles.accountName, { color: theme.colors.text }]} numberOfLines={1}>
                {hero?.displayName}
              </Text>
              {hero?.addressLine ? (
                <Text
                  style={[styles.accountAddress, { color: theme.colors.textSecondary }]}
                  numberOfLines={1}
                >
                  {hero.addressLine}
                </Text>
              ) : null}
            </View>
            <View style={[styles.chevronCircle, { backgroundColor: theme.colors.contrast50 }]}>
              <Animated.View style={chevronStyle}>
                <MaterialCommunityIcons name="chevron-down" size={20} color={theme.colors.text} />
              </Animated.View>
            </View>
          </PressableScale>
        </View>

        <GroupedSectionCollapse open={expanded} testID="account-switcher-content">
          {listItems}

          <AccountAffordanceRow
            icon="plus"
            label={t('accountMenu.addAnother')}
            onPress={handlers.onAdd}
            disabled={busy}
            theme={theme}
          />

          <AccountAffordanceRow
            icon="logout"
            label={t('accountMenu.signOut')}
            onPress={menu.onSignOut}
            disabled={busy}
            theme={theme}
          />
        </GroupedSectionCollapse>
        <GroupedSectionItem
          icon={<LogoIcon height={22} />}
          title={manageLabel}
          onPress={handlers.onManage}
          showChevron={false}
        />
      </GroupedSection>

      {/* Bloom owns the usage readout, meter and expandable breakdown. */}
      <UsageCard
        title={t('accountMenu.storage.title')}
        style={styles.menuGroup}
        usage={accountStorageUsage(storage, theme.colors, t)}
        formatValue={formatStorageSize}
        labels={{ freeSpace: t('accountMenu.storage.free') }}
        fallback={
          <Text className="text-bodySmall text-text-secondary">
            {t('accountMenu.storage.unavailable')}
          </Text>
        }
        footer={
          shouldShowStorageActions(storage) ? (
            <View className="flex-row justify-end gap-space-8">
              <StorageChip
                label={t('accountMenu.storage.getStorage')}
                onPress={menu.onUpgradeStorage}
              />
              <StorageChip
                label={t('accountMenu.storage.cleanUp')}
                onPress={menu.onManageStorage}
              />
            </View>
          ) : undefined
        }
      />

      <GroupedSection style={styles.menuGroup}>
        <GroupedSectionItem
          icon={
            <GroupedSectionIcon>
              {({ color, size }) => <RiSparklingFill fill={color} width={size} height={size} />}
            </GroupedSectionIcon>
          }
          title={
            storage?.plan === 'pro' || storage?.plan === 'business'
              ? t('accountMenu.plan.current', { plan: storage.plan === 'pro' ? 'Pro' : 'Business' })
              : t(storage?.plan === 'basic' ? 'accountMenu.plan.get' : 'accountMenu.plan.explore')
          }
          description={
            storage?.plan === 'pro' || storage?.plan === 'business'
              ? t('accountMenu.plan.manage')
              : undefined
          }
          onPress={menu.onOpenPlan}
          showChevron={false}
        />
      </GroupedSection>

      {menu.sections.map((section) => (
        <GroupedSection key={section.key} title={section.title} style={styles.menuGroup}>
          {section.items.map((item) => (
            <GroupedSectionItem
              key={item.key}
              icon={
                typeof item.icon === 'string' || !item.icon ? (
                  <MenuIcon
                    name={
                      (item.icon ??
                        'dots-horizontal') as keyof typeof MaterialCommunityIcons.glyphMap
                    }
                  />
                ) : (
                  item.icon
                )
              }
              title={item.label}
              description={item.description}
              value={item.badge}
              disabled={item.disabled}
              onPress={item.onPress}
              showChevron={false}
            />
          ))}
        </GroupedSection>
      ))}

      {/* MENU — the same stock grouped section. */}
      <GroupedSection style={styles.menuGroup}>
        <GroupedSectionItem
          icon={<MenuIcon name="tray-arrow-down" />}
          title={t('accountMenu.data')}
          description={t('accountMenu.dataDescription')}
          onPress={menu.onOpenData}
          showChevron={false}
        />
        <GroupedSectionItem
          icon={<MenuIcon name="cog-outline" tone="info" />}
          title={t('accountMenu.settings')}
          description={t('accountMenu.settingsDescription')}
          onPress={menu.onOpenSettings}
          showChevron={false}
        />
        <GroupedSectionItem
          icon={<MenuIcon name="help-circle-outline" />}
          title={t('accountMenu.help')}
          description={t('accountOverview.items.help.subtitle')}
          onPress={menu.onHelp}
          showChevron={false}
        />
      </GroupedSection>

      {/* FOOTER. */}
      <View className="flex-row items-center justify-center gap-space-12 px-space-12 pt-space-12 pb-space-8">
        <LinkButton size="sm" linkTone="secondary" onPress={menu.onPrivacy}>
          {t('accountMenu.privacy')}
        </LinkButton>
        <Text className="text-bodySmall text-text-tertiary">·</Text>
        <LinkButton size="sm" linkTone="secondary" onPress={menu.onTerms}>
          {t('accountMenu.terms')}
        </LinkButton>
      </View>
    </View>
  );
};

/**
 * The person a block of accounts hangs off, with the one action that removes
 * THEM rather than one of their accounts.
 *
 * The distinction is the reason this row exists: dropping Alice's route to an
 * organization is not the same as dropping Alice, and on a shared device the
 * second must not touch Nate's route to the same organization. Two different
 * server calls, two different rows, never one control doing both.
 */
const PrincipalHeaderRow: React.FC<{
  principal: SwitcherPrincipalRow;
  removing: boolean;
  disabled: boolean;
  onSignOut: () => void;
  theme: Theme;
  t: Translate;
}> = ({ principal, removing, disabled, onSignOut, theme, t }) => {
  const signOutLabel = t('accountSwitcher.principal.signOut', { name: principal.displayName });
  return (
    <View className="flex-row items-center gap-space-12 px-space-12 pt-space-12 pb-space-8">
      <Avatar
        source={principal.avatarUrl ?? undefined}
        variant="thumb"
        name={principal.displayName}
        size={PRINCIPAL_AVATAR_SIZE}
      />
      <View className="flex-1 min-w-0">
        <Text className="text-caption font-semibold text-text" numberOfLines={1}>
          {principal.displayName}
        </Text>
        {principal.handle ? (
          <Text className="text-caption text-text-tertiary" numberOfLines={1}>
            {`@${principal.handle}`}
          </Text>
        ) : null}
      </View>
      <Button
        appearance="plain"
        tone="neutral"
        size="sm"
        onPress={onSignOut}
        disabled={disabled}
        loading={removing}
        accessibilityLabel={signOutLabel}
      >
        {t('accountMenu.signOut')}
      </Button>
    </View>
  );
};

/**
 * One `principal acting as account` row.
 *
 * Pressing it activates the PAIR — a `contextId`, not an account id, because on
 * this device the account below may also be reachable through somebody else.
 * A row the server marks unavailable is rendered rather than hidden, so a
 * membership going away is something the person can see instead of a row that
 * silently stopped existing; it is disabled, because activating it is a request
 * the server answers with a 403 and then heals the row away.
 */
const ContextRow: React.FC<{
  context: SwitcherContextRow;
  principalName: string;
  /**
   * This ROW's own accent, resolved from `context.color` by the caller. Never
   * the signed-in account's: two people on one device would then be drawn in
   * whichever of them happens to be active.
   */
  accent: string;
  activating: boolean;
  removing: boolean;
  disabled: boolean;
  onActivate: () => void;
  onRemove: () => void;
  theme: Theme;
  t: Translate;
}> = ({
  context,
  principalName,
  accent,
  activating,
  removing,
  disabled,
  onActivate,
  onRemove,
  theme,
  t,
}) => {
  const unavailable = !context.canActivate;
  const rowDisabled = disabled || unavailable;
  const removeLabel = t('accountSwitcher.context.remove', {
    account: context.displayName,
    person: principalName,
  });
  return (
    <View className="flex-row items-center">
      <View className="flex-1 min-w-0">
        <GroupedSectionItem
          title={context.displayName}
          description={
            unavailable
              ? t('accountSwitcher.context.unavailable')
              : context.handle
                ? `@${context.handle}`
                : undefined
          }
          icon={
            <Avatar
              source={context.avatarUrl ?? undefined}
              variant="thumb"
              name={context.displayName}
              size={SWITCH_AVATAR_SIZE}
            />
          }
          onPress={onActivate}
          disabled={rowDisabled}
          accessibilityState={{
            selected: context.isActive,
            disabled: rowDisabled,
            busy: activating,
          }}
          accessibilityLabel={context.displayName}
          showChevron={false}
          rightElement={activating ? <SpinnerIcon size={20} color={accent} /> : undefined}
        />
      </View>
      <Button
        appearance="plain"
        tone="neutral"
        size="sm"
        iconOnly
        onPress={onRemove}
        disabled={disabled}
        loading={removing}
        accessibilityLabel={removeLabel}
        icon={<MaterialCommunityIcons name="close" size={18} />}
      />
    </View>
  );
};

/**
 * Account actions align with the avatars above them inside the same Bloom group.
 */
const AccountAffordanceRow: React.FC<{
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  theme: Theme;
}> = ({ icon, label, onPress, disabled, theme }) => (
  <GroupedSectionItem
    title={label}
    onPress={onPress}
    disabled={disabled}
    showChevron={false}
    icon={<MenuIcon name={icon} />}
  />
);

/** Bloom owns the icon surface, sizing and contrast. */
const MenuIcon: React.FC<{
  name: keyof typeof MaterialCommunityIcons.glyphMap;
  tone?: React.ComponentProps<typeof GroupedSectionIcon>['tone'];
}> = ({ name, tone }) => (
  <GroupedSectionIcon tone={tone}>
    {({ color, size }) => <MaterialCommunityIcons name={name} size={size} color={color} />}
  </GroupedSectionIcon>
);

const StorageChip: React.FC<{ label: string; onPress: () => void }> = ({ label, onPress }) => (
  <Button appearance="plain" size="sm" onPress={onPress} accessibilityLabel={label}>
    {label}
  </Button>
);

export default AccountsMenuView;
