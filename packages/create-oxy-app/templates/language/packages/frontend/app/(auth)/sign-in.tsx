import { Embed, Text, VStack } from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';
import { OxySignInButton } from '@oxy.so/services';
import { useTranslation } from '@/lib/i18n';

/**
 * Signing in opens the in-app `OxyAccountDialog` (account switcher, "Sign in
 * with Oxy", password): never a redirect to an external IdP. The SDK's button
 * has no language node, so it is embedded as it is.
 */
export default screen(function SignInScreen() {
  const { t } = useTranslation();
  return VStack(
    Text(t('auth.title')).font('title-2').weight('semibold').textAlign('center'),
    Text(t('auth.subtitle')).foreground('muted').textAlign('center'),
    Embed(<OxySignInButton variant="contained" />),
  )
    .spacing('sm')
    .align('center')
    .justify('center')
    .padding('lg')
    .grow()
    .header(false);
});
