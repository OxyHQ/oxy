/**
 * The shell every Oxy sign-in screen shares — the in-app account dialog and
 * every page of the auth.oxy.so IdP render these, so the two cannot drift:
 *
 *   header   the Oxy mark (56), then the title (48/800, tight) and a 18px
 *            description, 8 apart
 *   screen   blocks 24 apart, at most 448 wide
 *   split    from `md`, Bloom `AuthCard`'s split base — max 880, radius 24,
 *            1px border, two equal columns, the right one on the secondary
 *            surface; below `md` the right column is dropped, not stacked
 *   loading  an indeterminate spinner holding the screen's height
 *   terms    one centred caption linking the Terms of Service and Privacy Policy
 *
 * Layout is NativeWind `className` (breakpoints included). Type stays on
 * Bloom `Text`'s own ramp through `style` — a `className` there drops its
 * default family — and colours come from the Bloom theme.
 */

import type React from 'react';
import { ActivityIndicator, Linking, Text as RNText } from 'react-native';
import { View } from 'react-native-css/components';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { useI18n } from '../../hooks/useI18n';
import { LogoIcon } from '../logo/LogoIcon';

const LOGO_HEIGHT = 56;
const TERMS_URL = 'https://oxy.so/company/transparency/policies/terms-of-service';
const PRIVACY_URL = 'https://oxy.so/company/transparency/policies/privacy';

const TITLE = { fontSize: 48, lineHeight: 48, fontWeight: '800', letterSpacing: -1.2 } as const;
const DESCRIPTION = { fontSize: 18, lineHeight: 28 } as const;
const TERMS = { fontSize: 14, lineHeight: 20, textAlign: 'center', paddingHorizontal: 24 } as const;

export interface OxyAuthScreenHeaderProps {
  title: string;
  description?: React.ReactNode;
}

/** The Oxy mark over the screen's title and description. */
export const OxyAuthScreenHeader: React.FC<OxyAuthScreenHeaderProps> = ({ title, description }) => {
  const theme = useTheme();
  return (
    <View className="gap-6">
      <LogoIcon height={LOGO_HEIGHT} />
      <View className="max-w-[90%] gap-2">
        <Text accessibilityRole="header" style={[TITLE, { color: theme.colors.text }]}>
          {title}
        </Text>
        {description != null && description !== '' ? (
          typeof description === 'string' ? (
            <Text style={[DESCRIPTION, { color: theme.colors.textSecondary }]}>
              {description}
            </Text>
          ) : (
            description
          )
        ) : null}
      </View>
    </View>
  );
};

/** A sign-in screen's column: its blocks 24 apart. `className` extends it (the split's form column). */
export const OxyAuthScreen: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <View className={`w-full max-w-[448px] self-center gap-6 ${className ?? ''}`}>{children}</View>
);

/**
 * The split card: `children` on the left and, from `md`, `aside` on the right.
 * `bare` inside a surface that already is the card (the account dialog): no
 * border of its own, and the right column is a rounded tile within the
 * dialog's margins.
 */
export const OxyAuthSplit: React.FC<{ children: React.ReactNode; aside: React.ReactNode; bare?: boolean }> = ({
  children,
  aside,
  bare = false,
}) => {
  const theme = useTheme();
  return (
    <View
      className={`w-full self-center md:max-w-[880px] md:flex-row ${bare ? 'md:gap-8' : 'md:rounded-3xl md:border md:border-border md:bg-card md:overflow-hidden'}`}
    >
      {/* Padding on an inner box: a padded flex item cannot shrink its base
          size below its padding, which breaks the two equal tracks. */}
      <View className="md:flex-1 md:basis-0 md:min-w-0">
        <View className={bare ? '' : 'md:p-8'}>{children}</View>
      </View>
      <View
        className={`hidden md:flex md:flex-1 md:basis-0 md:min-w-0 items-center justify-center overflow-hidden p-8 ${bare ? 'rounded-[20px]' : ''}`}
        style={{ backgroundColor: theme.colors.backgroundSecondary }}
      >
        {aside}
      </View>
    </View>
  );
};

/**
 * The screen while there is nothing to show yet. React Native's own indicator:
 * `@oxy.so/bloom/loading` can tree-shake to `undefined` in a rolldown-vite
 * production bundle when co-imported with `@oxy.so/bloom/button`.
 */
export const OxyAuthLoading: React.FC = () => {
  const theme = useTheme();
  return (
    <View className="min-h-[300px] items-center justify-center">
      <ActivityIndicator size="large" color={theme.colors.primary} />
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
      <RNText accessibilityRole="link" style={link} onPress={() => void Linking.openURL(PRIVACY_URL)}>
        {t('signin.terms.privacyLink')}
      </RNText>
      .
    </Text>
  );
};
