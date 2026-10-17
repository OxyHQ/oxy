import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import type { AccountInvitationPreview } from '@oxy.so/core';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { useOxy } from '../context/oxyRuntimeContext';

/** The link never grants access on navigation, preview, sign-in or account switching. */
export function AccountInvitationAcceptance({ token }: { token: string }) {
  return <InvitationContent key={token} token={token} />;
}

function InvitationContent({ token }: { token: string }) {
  const { oxyServices, user, canUsePrivateApi, openAccountDialog } = useOxy();
  const [preview, setPreview] = useState<AccountInvitationPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  useEffect(() => {
    let alive = true;
    setPreview(null);
    setError('');
    if (canUsePrivateApi && token) {
      oxyServices.accounts.invitations
        .preview(token)
        .then((value) => {
          if (alive) setPreview(value);
        })
        .catch((reason) => {
          if (alive) setError(reason instanceof Error ? reason.message : 'Invitation unavailable');
        });
    }
    return () => {
      alive = false;
    };
  }, [oxyServices, canUsePrivateApi, token]);

  const accept = async () => {
    if (!user || !preview) return;
    setBusy(true);
    setError('');
    try {
      await oxyServices.accounts.invitations.accept(token, user.id);
      setAccepted(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not accept invitation');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-space-16 p-space-24">
      <Text className="text-title font-semibold text-text">Account invitation</Text>
      {canUsePrivateApi && token && !preview && !error ? (
        <Text accessibilityRole="progressbar">Loading invitation…</Text>
      ) : null}
      {accepted ? (
        <Text>Invitation accepted. You can now access this account.</Text>
      ) : (
        <>
          {preview ? (
            <Text>
              Join {preview.account.displayName ?? preview.account.username} as{' '}
              {preview.invitation.role}.
            </Text>
          ) : null}
          <Text>
            Selected account:{' '}
            {user
              ? `${user.name?.displayName ?? getNormalizedUserHandle(user) ?? user.id} (${user.email ?? user.id})`
              : 'Not signed in'}
          </Text>
          <Text>
            The selected account receives access. Its email can differ from the invitation address.
            No access is granted until you confirm.
          </Text>
          <Button disabled={busy} onPress={() => openAccountDialog()}>
            {user ? 'Change account' : 'Sign in or create account'}
          </Button>
          <Button disabled={busy || !user || !preview || user.kind !== 'personal'} onPress={accept}>
            Confirm and accept
          </Button>
        </>
      )}
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      {!token ? <Text>This invitation link is incomplete.</Text> : null}
    </View>
  );
}
