/**
 * What every security panel of the signed-in account reads first: whether it
 * holds a Commons key (it signs in with Commons, nothing here applies),
 * whether it is a personal account (only those sign in with an email, a
 * password or an authenticator — the API refuses the rest), and how it signs
 * in. A panel that cannot show its methods says why instead of spinning.
 */

import type React from 'react';
import { Button } from '@oxy.so/bloom/button';
import type { SignInMethods } from '@oxy.so/contracts';
import type { UseQueryResult } from '@tanstack/react-query';
import { useOxy } from '../../context/oxyRuntimeContext';
import { useSignInMethods } from '../../hooks/queries/useAuthMethods';
import type { Translate } from '../authChooser/types';
import { OxyAuthLoading, OxyAuthScreen, OxyAuthScreenHeader } from './OxyAuthScreen';
import { AccountFlowNotice } from './accountFlowParts';

export interface AccountSecurityState {
  /** The account holds a Commons key. */
  keyed: boolean;
  /** A personal account (an organization, project or bot signs in through its people). */
  personal: boolean;
  methods: UseQueryResult<SignInMethods>;
}

export function useAccountSecurityState(): AccountSecurityState {
  const { user } = useOxy();
  const keyed = Boolean(user?.publicKey);
  const personal = !user?.kind || user.kind === 'personal';
  const methods = useSignInMethods({ enabled: !keyed && personal });
  return { keyed, personal, methods };
}

/**
 * The screen a panel shows while its methods are not there to act on: not a
 * personal account, the read failed (with a retry), or still loading. `null`
 * once `methods.data` is ready.
 */
export function accountSecurityFallback(
  state: AccountSecurityState,
  title: string,
  t: Translate,
): React.ReactElement | null {
  if (!state.personal) {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader title={title} />
        <AccountFlowNotice testID="account-security-not-personal">
          {t('signInSecurity.notPersonal')}
        </AccountFlowNotice>
      </OxyAuthScreen>
    );
  }
  if (state.methods.isError && !state.methods.data) {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader title={title} />
        <AccountFlowNotice type="error" testID="account-security-failed">
          {t('signInSecurity.loadFailed')}
        </AccountFlowNotice>
        <Button
          appearance="outline"
          size="lg"
          onPress={() => void state.methods.refetch()}
          testID="account-security-retry"
        >
          {t('signInSecurity.retry')}
        </Button>
      </OxyAuthScreen>
    );
  }
  if (!state.methods.data) return <OxyAuthLoading />;
  return null;
}
