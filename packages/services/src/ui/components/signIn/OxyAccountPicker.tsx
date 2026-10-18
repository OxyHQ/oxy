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
import { ScrollView } from 'react-native';
import { View } from 'react-native-css/components';
import { Avatar } from '@oxy.so/bloom/avatar';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiUserAddLine } from '@oxy.so/bloom/icons/RiUserAddLine';
import { SpinnerIcon } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import {
  GroupedSection,
  GroupedSectionItem,
  GroupedSectionIcon,
} from '@oxy.so/bloom/grouped-section';
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
      <View testID="account-picker-list">
        <ScrollView style={{ maxHeight: LIST_MAX_HEIGHT }}>
          <GroupedSection>
            {rows.map(({ context, operatedBy }) => {
              const activating = pendingContextId === context.contextId;
              const disabled = isLoading || !context.canActivate;
              const current = !signedOut && context.isActive;
              const accent = resolveAccentHex(context.color, theme.colors.primary);
              const handle = context.handle ? `@${context.handle}` : undefined;
              const label = signedOut
                ? t('signin.chooser.continueAs', { name: handle ?? context.displayName })
                : context.displayName;
              return (
                <GroupedSectionItem
                  key={context.contextId}
                  title={context.displayName}
                  description={operatedBy ?? handle}
                  onPress={() => onSelectContext(context)}
                  disabled={disabled}
                  accessibilityLabel={label}
                  accessibilityState={{ selected: current, disabled, busy: activating }}
                  icon={
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
                  }
                  rightElement={activating ? <SpinnerIcon size={20} color={accent} /> : undefined}
                  showChevron={!activating}
                />
              );
            })}
            <GroupedSectionItem
              title={t('signin.chooser.useAnother')}
              onPress={onUseAnother}
              disabled={isLoading}
              testID="use-another-account"
              icon={
                <GroupedSectionIcon>
                  {({ color }) => <RiUserAddLine size="sm" fill={color} />}
                </GroupedSectionIcon>
              }
            />
          </GroupedSection>
        </ScrollView>
      </View>
      <OxyAuthTerms />
    </OxyAuthScreen>
  );
};
