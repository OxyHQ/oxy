import type React from 'react';
import { View } from 'react-native';
import { OxySignInSecurityPanel } from '../components/signIn/OxySignInSecurityPanel';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import type { BaseScreenProps } from '../types/navigation';

/** `SignInSecurity`: how the account signs in, and where it is signed in. */
const SignInSecurityScreen: React.FC<BaseScreenProps> = ({ navigate }) => {
  const { t } = useI18n();
  useSurfaceHeader({ title: t('signInSecurity.title') });
  return (
    <View className="px-screen-margin pb-space-24">
      <OxySignInSecurityPanel onOpen={navigate ? (route) => navigate(route) : undefined} />
    </View>
  );
};

export default SignInSecurityScreen;
