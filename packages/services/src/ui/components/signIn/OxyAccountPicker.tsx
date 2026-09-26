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
 */

import type React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiUserAddLine } from '@oxy.so/bloom/icons/RiUserAddLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { showsPrincipalHeaders, type SwitcherContextRow, type SwitcherPrincipalRow } from '@oxy.so/core/session';
import { useI18n } from '../../hooks/useI18n';
import { AccountRow } from '../authChooser/primitives';
import { authChooserStyles } from '../authChooser/styles';
import { OxyAuthScreen, OxyAuthScreenHeader, OxyAuthTerms } from './OxyAuthScreen';

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
   * This origin holds no session. A row then reads "Continue as @handle" and
   * never as the current account: the device can list an identity as active
   * while nobody is signed in HERE.
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

  return (
    <OxyAuthScreen>
      <OxyAuthScreenHeader
        title={t('signin.chooser.title')}
        description={appName ? t('signin.chooser.subtitleToApp', { app: appName }) : t('signin.chooser.subtitle')}
      />
      <View style={authChooserStyles.rows}>
        {principals.flatMap((principal) =>
          principal.contexts.map((context) => (
            <AccountRow
              key={context.contextId}
              context={context}
              operatedBy={
                namesTheOperator && context.isDelegated
                  ? t('accountSwitcher.context.operatedBy', { name: principal.displayName })
                  : null
              }
              continueAsLabel={
                signedOut
                  ? t('signin.chooser.continueAs', {
                      name: context.handle ? `@${context.handle}` : context.displayName,
                    })
                  : null
              }
              theme={theme}
              activating={pendingContextId === context.contextId}
              disabled={isLoading}
              onPress={() => onSelectContext(context)}
            />
          )),
        )}
        <Pressable
          onPress={onUseAnother}
          disabled={isLoading}
          accessibilityRole="button"
          accessibilityLabel={t('signin.chooser.useAnother')}
          style={[
            authChooserStyles.accountRow,
            { borderColor: theme.colors.border, backgroundColor: theme.colors.card },
            isLoading ? authChooserStyles.rowDisabled : null,
          ]}
          testID="use-another-account"
        >
          <View style={[styles.addGlyph, { backgroundColor: theme.colors.backgroundSecondary }]}>
            <RiUserAddLine size="md" fill={theme.colors.textSecondary} />
          </View>
          <Text style={[authChooserStyles.rowName, styles.addLabel, { color: theme.colors.text }]}>
            {t('signin.chooser.useAnother')}
          </Text>
          <RiArrowRightSLine size="md" fill={theme.colors.textSecondary} />
        </Pressable>
      </View>
      <OxyAuthTerms />
    </OxyAuthScreen>
  );
};

const styles = StyleSheet.create({
  // Matches `AccountRow`'s 40px avatar plus its 2px ring and 1px gap.
  addGlyph: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addLabel: {
    flex: 1,
  },
});
