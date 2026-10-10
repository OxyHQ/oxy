/**
 * "Choose an account" — every `principal acting as account` pair on this
 * device, then "Use another account".
 *
 * The front screen of sign-in on a returning device, in the account dialog and
 * on every auth.oxy.so page that asks WHO (sign-in, OAuth authorize, device
 * approval, MCP linking). Presentational: the host decides what choosing a row
 * means — a switch, a "Continue as" sign-in, or activating the pair before an
 * OAuth consent — and passes the pair back, never an account id, which cannot
 * say whose route was chosen.
 *
 * One rounded list: each row is the account's name and `@handle` on the left,
 * its avatar and a chevron on the right, with a hairline between rows that
 * steps aside for a hovered row. Layout is NativeWind; hover is driven by
 * `onHoverIn`/`onHoverOut` (web only), because this pipeline does not emit
 * `hover:` variants — the same pattern as the account menu.
 */

import type React from 'react';
import { Fragment, useState } from 'react';
import { ScrollView } from 'react-native';
import { Pressable, View } from 'react-native-css/components';
import { Avatar } from '@oxy.so/bloom/avatar';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiUserAddLine } from '@oxy.so/bloom/icons/RiUserAddLine';
import { SpinnerIcon } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import {
  showsPrincipalHeaders,
  type SwitcherContextRow,
  type SwitcherPrincipalRow,
} from '@oxy.so/core/session';
import { useI18n } from '../../hooks/useI18n';
import { resolveAccentHex } from '../authChooser/types';
import { OxyAuthScreen, OxyAuthScreenHeader, OxyAuthTerms } from './OxyAuthScreen';

/** The list scrolls past this height (`max-h-96`). */
const LIST_MAX_HEIGHT = 384;
const AVATAR_SIZE = 40;

export interface OxyAccountPickerProps {
  /** The device's people, each with the accounts they may act as (`useDeviceSwitcher`). */
  principals: SwitcherPrincipalRow[];
  /** The app being continued to, when there is one. */
  appName?: string | null;
  onSelectContext: (context: SwitcherContextRow) => void;
  /** "Use another account" — the host reveals its sign-in. */
  onUseAnother: () => void;
  /** The pair being activated, whose row shows it is busy. */
  pendingContextId?: string | null;
  /** Disables every row while a choice is in flight. */
  isLoading?: boolean;
  /**
   * This origin holds no session. A row is then announced as "Continue as
   * @handle" and never marked as the current account: the device can list an
   * identity as active while nobody is signed in HERE.
   */
  signedOut?: boolean;
}

export const OxyAccountPicker: React.FC<OxyAccountPickerProps> = ({
  principals,
  appName,
  onSelectContext,
  onUseAnother,
  pendingContextId = null,
  isLoading = false,
  signedOut = false,
}) => {
  const theme = useTheme();
  const { t } = useI18n();
  const [hovered, setHovered] = useState<number | null>(null);
  // Whose route a row is only needs naming once someone holds more than one
  // account here — the same rule the account menu's group headers follow.
  const namesTheOperator = showsPrincipalHeaders(principals);

  const rows = principals.flatMap((principal) =>
    principal.contexts.map((context) => ({
      context,
      operatedBy:
        namesTheOperator && context.isDelegated
          ? t('accountSwitcher.context.operatedBy', { name: principal.displayName })
          : null,
    })),
  );
  const useAnotherIndex = rows.length;

  /** The hairline under row `index`, hidden while either neighbour is hovered. */
  const divider = (index: number) =>
    hovered === index || hovered === index + 1 ? (
      <View className="h-px mx-[8px]" />
    ) : (
      <View className="h-px mx-[8px] bg-border opacity-50" />
    );

  const rowClassName = (index: number, disabled: boolean) =>
    `flex-row items-center gap-[12px] rounded-[14px] p-[8px] ${hovered === index && !disabled ? 'bg-fill' : ''} ${disabled ? 'opacity-50' : ''}`;

  return (
    <OxyAuthScreen>
      <OxyAuthScreenHeader
        title={t('signin.chooser.title')}
        description={
          appName
            ? t('signin.chooser.subtitleToApp', { app: appName })
            : t('signin.chooser.subtitle')
        }
      />
      <View
        className="bg-fill-secondary rounded-[22px] overflow-hidden"
        testID="account-picker-list"
      >
        <ScrollView style={{ maxHeight: LIST_MAX_HEIGHT }} contentContainerStyle={{ padding: 8 }}>
          {rows.map(({ context, operatedBy }, index) => {
            const activating = pendingContextId === context.contextId;
            const disabled = isLoading || !context.canActivate;
            const current = !signedOut && context.isActive;
            const accent = resolveAccentHex(context.color, theme.colors.primary);
            const handle = context.handle ? `@${context.handle}` : null;
            const label = signedOut
              ? t('signin.chooser.continueAs', { name: handle ?? context.displayName })
              : context.displayName;
            return (
              <Fragment key={context.contextId}>
                <Pressable
                  className={rowClassName(index, disabled && !activating)}
                  onPress={() => onSelectContext(context)}
                  onHoverIn={() => setHovered(index)}
                  onHoverOut={() => setHovered((value) => (value === index ? null : value))}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: current, disabled, busy: activating }}
                >
                  <View className="flex-1 min-w-0">
                    <Text
                      className="text-body text-text"
                      style={{ fontWeight: '500' }}
                      numberOfLines={1}
                    >
                      {context.displayName}
                    </Text>
                    {operatedBy || handle ? (
                      <Text className="text-bodySmall text-text-secondary" numberOfLines={1}>
                        {operatedBy ?? handle}
                      </Text>
                    ) : null}
                  </View>
                  <View className="flex-row items-center gap-[8px] shrink-0">
                    {/* The current account: Avatar's own verified slot (bottom-right,
                        above the image), holding the accent check badge. */}
                    <Avatar
                      source={context.avatarUrl ?? undefined}
                      variant="thumb"
                      name={context.displayName}
                      size={AVATAR_SIZE}
                      verified={current}
                      verifiedIcon={
                        <View
                          className="items-center justify-center rounded-full border-2 border-background"
                          style={{ width: 18, height: 18, backgroundColor: accent }}
                        >
                          <RiCheckLine size="xs" fill="#ffffff" />
                        </View>
                      }
                    />
                    {activating ? (
                      <SpinnerIcon size={20} color={accent} />
                    ) : (
                      <RiArrowRightSLine size="sm" fill={theme.colors.textSecondary} />
                    )}
                  </View>
                </Pressable>
                {divider(index)}
              </Fragment>
            );
          })}
          <Pressable
            className={rowClassName(useAnotherIndex, isLoading)}
            onPress={onUseAnother}
            onHoverIn={() => setHovered(useAnotherIndex)}
            onHoverOut={() => setHovered((value) => (value === useAnotherIndex ? null : value))}
            disabled={isLoading}
            accessibilityRole="button"
            accessibilityLabel={t('signin.chooser.useAnother')}
            testID="use-another-account"
          >
            <View className="flex-1 min-w-0">
              <Text className="text-body text-text" style={{ fontWeight: '500' }} numberOfLines={1}>
                {t('signin.chooser.useAnother')}
              </Text>
            </View>
            <View className="flex-row items-center gap-[8px] shrink-0">
              <View
                className="bg-fill items-center justify-center rounded-full"
                style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
              >
                <RiUserAddLine size="md" fill={theme.colors.textSecondary} />
              </View>
              <RiArrowRightSLine size="sm" fill={theme.colors.textSecondary} />
            </View>
          </Pressable>
        </ScrollView>
      </View>
      <OxyAuthTerms />
    </OxyAuthScreen>
  );
};
