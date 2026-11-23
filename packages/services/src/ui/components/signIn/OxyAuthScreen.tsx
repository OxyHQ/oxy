/**
 * The shell every Oxy sign-in screen shares — the in-app account dialog and
 * every page of the auth.oxy.so IdP render these, so the two cannot drift:
 *
 *   header   the Oxy mark (56) or the screen's own icon, then the title
 *            (48/800, tight) and a 18px description, 8 apart
 *   screen   blocks 24 apart, at most 448 wide
 *   split    from `md`, Bloom `AuthCard`'s split base — max 880, radius 24,
 *            1px border, two equal columns, the right one on the secondary
 *            surface; below `md` the right column is dropped, not stacked
 *   loading  an indeterminate spinner holding the screen's height
 *   terms    one centred caption linking the Terms of Service and Privacy Policy
 *
 * Layout is `StyleSheet`, the `md` breakpoint read from Bloom's
 * `useWindowBreakpoint`; colours come from the Bloom theme.
 */

import type React from 'react';
import { Linking, Platform, Text as RNText, StyleSheet, View } from 'react-native';
import { Loading } from '@oxy.so/bloom/loading';
import { useWindowBreakpoint } from '@oxy.so/bloom/hooks';
import { createTokenStyles, useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { useI18n } from '../../hooks/useI18n';
import { LogoIcon } from '../logo/LogoIcon';

const LOGO_HEIGHT = 56;
const TERMS_URL = 'https://oxy.so/company/transparency/policies/terms-of-service';
const PRIVACY_URL = 'https://oxy.so/company/transparency/policies/privacy';

const TITLE = { fontSize: 48, lineHeight: 48, fontWeight: '800', letterSpacing: -1.2 } as const;
const DESCRIPTION = { fontSize: 18, lineHeight: 28 } as const;
const TERMS = { fontSize: 14, lineHeight: 20, textAlign: 'center', paddingHorizontal: 24 } as const;
/** A title focused by code is a place, not a control: no focus ring. */
const PLACE = { outlineWidth: 0 } as const;

export interface OxyAuthScreenHeaderProps {
  title: string;
  description?: React.ReactNode;
  /** Drawn in place of the Oxy mark (a platform's own step icon), at most 56 tall. */
  icon?: React.ReactNode;
  /**
   * The title's host view, for a surface that moves focus to it (a setup
   * assistant's step change). Given, the title also takes focus from code on
   * the web (`tabIndex` -1), never from Tab.
   */
  titleRef?: React.Ref<React.ComponentRef<typeof RNText>>;
}

/** The Oxy mark (or the screen's icon) over the screen's title and description. */
export const OxyAuthScreenHeader: React.FC<OxyAuthScreenHeaderProps> = ({
  title,
  description,
  icon,
  titleRef,
}) => {
  const theme = useTheme();
  const focusable = titleRef != null && Platform.OS === 'web';
  return (
    <View style={styles.stack}>
      {icon ?? <LogoIcon height={LOGO_HEIGHT} />}
      <View style={styles.titleBlock}>
        <Text
          accessibilityRole="header"
          // Bloom's `Text` hands `ref` (a prop in React 19) and react-native-web's
          // `tabIndex` to its host text; neither is in React Native's `TextProps`.
          {...{ ref: titleRef }}
          {...(focusable ? { tabIndex: -1 } : null)}
          style={[TITLE, { color: theme.colors.text }, focusable ? PLACE : null]}
        >
          {title}
        </Text>
        {description != null && description !== '' ? (
          typeof description === 'string' ? (
            <Text style={[DESCRIPTION, { color: theme.colors.textSecondary }]}>{description}</Text>
          ) : (
            description
          )
        ) : null}
      </View>
    </View>
  );
};

/** Whether the window has reached Bloom's `md` breakpoint (768), where the sign-in split has two columns. */
export function useAuthSplitColumns(): boolean {
  const tier = useWindowBreakpoint();
  return tier !== 'base' && tier !== 'sm';
}

/**
 * A sign-in screen's column: its blocks 24 apart, at most 448 wide. `inSplit`: it is the
 * split's form column, which from `md` fills its half instead.
 */
export const OxyAuthScreen: React.FC<{ children: React.ReactNode; inSplit?: boolean }> = ({
  children,
  inSplit = false,
}) => {
  const columns = useAuthSplitColumns();
  return (
    <View style={[styles.screen, inSplit && columns ? null : styles.screenCap]}>{children}</View>
  );
};

/**
 * The split card: `children` on the left and, from `md`, `aside` on the right.
 * `bare` inside a surface that already is the card (the account dialog): no
 * border of its own, and the right column is a rounded tile within the
 * dialog's margins.
 */
export const OxyAuthSplit: React.FC<{
  children: React.ReactNode;
  aside: React.ReactNode;
  bare?: boolean;
}> = ({ children, aside, bare = false }) => {
  const theme = useTheme();
  const split = useSplitStyles();
  const columns = useAuthSplitColumns();
  return (
    <View style={[split.card, columns ? (bare ? split.cardBare : split.cardFramed) : null]}>
      {/* Padding on an inner box: a padded flex item cannot shrink its base
          size below its padding, which breaks the two equal tracks. */}
      <View style={columns ? split.column : null}>
        <View style={columns && !bare ? split.formPadding : null}>{children}</View>
      </View>
      <View
        style={[
          split.aside,
          columns ? split.column : split.hidden,
          bare ? split.asideBare : null,
          { backgroundColor: theme.colors.backgroundSecondary },
        ]}
      >
        {aside}
      </View>
    </View>
  );
};

/** The screen while there is nothing to show yet: Bloom's spinner, named for assistive technology. */
export const OxyAuthLoading: React.FC = () => {
  const { t } = useI18n();
  return (
    <View style={styles.centered}>
      <Loading
        variant="spinner"
        size="lg"
        accessibilityLabel={t('common.status.loading')}
        testID="oxy-auth-loading"
      />
    </View>
  );
};

/** "By continuing, you agree to our Terms of Service and Privacy Policy." */
export const OxyAuthTerms: React.FC = () => {
  const theme = useTheme();
  const { t } = useI18n();
  const link = { color: theme.colors.text, textDecorationLine: 'underline' as const };
  return (
    <Text style={[TERMS, { color: theme.colors.textSecondary }]}>
      {t('signin.terms.before')}{' '}
      <RNText accessibilityRole="link" style={link} onPress={() => void Linking.openURL(TERMS_URL)}>
        {t('signin.terms.termsLink')}
      </RNText>{' '}
      {t('signin.terms.and')}{' '}
      <RNText
        accessibilityRole="link"
        style={link}
        onPress={() => void Linking.openURL(PRIVACY_URL)}
      >
        {t('signin.terms.privacyLink')}
      </RNText>
      .
    </Text>
  );
};

const styles = StyleSheet.create({
  screen: { width: '100%', alignSelf: 'center', gap: 24 },
  screenCap: { maxWidth: 448 },
  stack: { gap: 24 },
  titleBlock: { maxWidth: '90%', gap: 8 },
  centered: { minHeight: 300, alignItems: 'center', justifyContent: 'center' },
});

/** The split, from `md`: two equal columns, framed as a card unless `bare`. */
const useSplitStyles = createTokenStyles((t) => ({
  card: { width: '100%', alignSelf: 'center' },
  cardBare: { maxWidth: 880, flexDirection: 'row', gap: 32 },
  cardFramed: {
    maxWidth: 880,
    flexDirection: 'row',
    overflow: 'hidden',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.card,
  },
  column: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  formPadding: { padding: 32 },
  aside: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', padding: 32 },
  asideBare: { borderRadius: 20 },
  hidden: { display: 'none' },
}));
