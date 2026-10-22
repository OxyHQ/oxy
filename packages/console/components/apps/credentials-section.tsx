import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiKey2Line } from '@oxy.so/bloom/icons/RiKey2Line';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import { type Href, useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import type {
  Application,
  ApplicationCredential,
  ApplicationCredentialType,
  ApplicationEnvironment,
  CallerAccess,
} from '@/hooks/use-applications';
import {
  useApplicationCredentials,
  useCreateCredential,
  useRevokeCredential,
  useRotateCredential,
} from '@/hooks/use-applications';
import { getErrorMessage } from '@/lib/api-error';
import {
  availablePaymentsScopes,
  isUntrustedThirdPartyApp,
  PAYMENTS_SCOPES,
} from '@/lib/application-scopes';
import { useTranslation } from '@/lib/i18n';
import { usePlaygroundKey } from '@/lib/playground-key';
import { CredentialTrail } from './credential-trail';
import { ChoiceSelect, SwitchRow, TextInputField } from './form-fields';
import { CopyValue, Notice, NoticeText, RowGroup, SectionBlock } from './primitives';

const CREDENTIAL_TYPES: ReadonlyArray<ApplicationCredentialType> = [
  'public',
  'confidential',
  'service',
  'machine',
];
const ENVIRONMENTS: ReadonlyArray<ApplicationEnvironment> = [
  'development',
  'staging',
  'production',
];

/**
 * Credential material shown ONCE, immediately after a create or a rotate.
 *
 * Held in component state only, cleared by the "I saved my secret" button, and
 * never read back from anywhere — the credentials list the API serves carries no
 * secret field at all.
 *
 * `secret` and `token` are separate and both optional because exactly one of
 * them exists per credential type: `secret` for a `confidential`/`service`
 * client, `token` for a `machine` API key, neither for a `public` client.
 * Collapsing them into one field would let an API key's bearer token be rendered
 * under the wrong label — or a `public` client's `null` be copied to the
 * clipboard as the string "null".
 */
interface RevealedSecret {
  credentialName: string;
  publicKey: string;
  secret: string | null;
  token?: string;
}

interface CredentialsSectionProps {
  application: Application;
  access: CallerAccess;
}

export function CredentialsSection({ application, access }: CredentialsSectionProps) {
  const { t } = useTranslation();
  const router = useRouter();
  // The playground's key holder. This is the ONLY moment a machine credential's
  // bearer token exists in the browser, so it is the only moment the hand-off is
  // possible — see `lib/playground-key.ts` for why it is a store, not router state.
  const setPlaygroundKey = usePlaygroundKey((state) => state.setApiKey);
  const appId = application._id;
  const canRead = access.can('credentials:read');
  const canCreate = access.can('credentials:create');
  const canRotate = access.can('credentials:rotate');
  const canRevoke = access.can('credentials:revoke');

  const { data: credentials = [], isLoading } = useApplicationCredentials(appId, canRead);
  const createCredential = useCreateCredential();
  const rotateCredential = useRotateCredential();
  const revokeCredential = useRevokeCredential();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<ApplicationCredentialType>('confidential');
  const [environment, setEnvironment] = useState<ApplicationEnvironment>('development');
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  /** Which credential's trail is expanded, if any. One at a time. */
  const [trailFor, setTrailFor] = useState<string | null>(null);
  const [credentialToRotate, setCredentialToRotate] = useState<ApplicationCredential | null>(null);
  const [credentialToRevoke, setCredentialToRevoke] = useState<ApplicationCredential | null>(null);

  const grantablePaymentsScopes = availablePaymentsScopes(application.scopes);
  const requiresPaymentsScopes = type === 'service' && isUntrustedThirdPartyApp(application);
  // A machine credential must name at least one scope — the API refuses a
  // scopeless one rather than defaulting it to the application's whole grant.
  const isMachineType = type === 'machine';

  const resetCreateForm = () => {
    setName('');
    setType('confidential');
    setEnvironment('development');
    setSelectedScopes([]);
  };

  const handleTypeChange = (value: ApplicationCredentialType) => {
    setType(value);
    setSelectedScopes(value === 'service' ? availablePaymentsScopes(application.scopes) : []);
  };

  const toggleScope = (scope: string, enabled: boolean) => {
    setSelectedScopes((current) => {
      if (enabled) return current.includes(scope) ? current : [...current, scope];
      return current.filter((item) => item !== scope);
    });
  };

  const createBlocked =
    !name.trim() ||
    (requiresPaymentsScopes && selectedScopes.length === 0) ||
    (isMachineType && selectedScopes.length === 0);

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.error(t('applications.credentials.nameRequired'));
      return;
    }
    if (requiresPaymentsScopes && selectedScopes.length === 0) {
      toast.error(t('applications.credentials.paymentsScopeRequired'));
      return;
    }
    if (isMachineType && selectedScopes.length === 0) {
      toast.error(t('applications.credentials.machineScopeRequired'));
      return;
    }
    try {
      const result = await createCredential.mutateAsync({
        appId,
        data: {
          name: name.trim(),
          type,
          environment,
          ...((type === 'service' || isMachineType) && selectedScopes.length > 0
            ? { scopes: selectedScopes }
            : {}),
        },
      });
      setShowCreateDialog(false);
      resetCreateForm();
      setRevealed({
        credentialName: result.credential.name,
        publicKey: result.credential.publicKey,
        secret: result.secret,
        token: result.token,
      });
      toast.success(t('applications.credentials.created'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.credentials.createFailed')));
    }
  };

  const handleRotate = async () => {
    if (!credentialToRotate) return;
    try {
      const result = await rotateCredential.mutateAsync({
        appId,
        credentialId: credentialToRotate._id,
      });
      setCredentialToRotate(null);
      setRevealed({
        credentialName: result.credential.name,
        publicKey: result.credential.publicKey,
        secret: result.secret,
        token: result.token,
      });
      toast.success(t('applications.credentials.rotated'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.credentials.rotateFailed')));
    }
  };

  const handleRevoke = async () => {
    if (!credentialToRevoke) return;
    try {
      await revokeCredential.mutateAsync({ appId, credentialId: credentialToRevoke._id });
      setCredentialToRevoke(null);
      toast.success(t('applications.credentials.revoked'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.credentials.revokeFailed')));
    }
  };

  if (!canRead) {
    return (
      <View className="py-12">
        <Text className="text-center text-sm text-muted-foreground">
          {t('applications.credentials.noPermission')}
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-4">
      <SectionBlock
        title={t('applications.credentials.title')}
        description={t('applications.credentials.subtitle')}
        action={
          canCreate ? (
            <Button
              leadingIcon={RiAddLine}
              onPress={() => {
                resetCreateForm();
                setShowCreateDialog(true);
              }}
            >
              {t('applications.credentials.create')}
            </Button>
          ) : undefined
        }
      />

      {/* Revealed secret — shown once */}
      {revealed ? (
        <Notice
          type="warning"
          title={t('applications.credentials.saveSecret', { name: revealed.credentialName })}
        >
          <NoticeText>{t('applications.credentials.shownOnce')}</NoticeText>
          <View className="gap-1">
            <Text className="text-xs text-muted-foreground">
              {t('applications.credentials.clientId')}
            </Text>
            <CopyValue
              value={revealed.publicKey}
              label={t('applications.credentials.copyClientId')}
              copiedMessage={t('applications.credentials.clientIdCopied')}
            />
          </View>
          {/* Rendered ONLY when the credential actually has one. A `public`
              client's `secret` is null and a machine credential's is too —
              without this guard the box would show an empty value and the copy
              would put the string "null" on the clipboard. */}
          {revealed.secret ? (
            <View className="gap-1">
              <Text className="text-xs text-muted-foreground">
                {t('applications.credentials.secret')}
              </Text>
              <CopyValue
                value={revealed.secret}
                label={t('applications.credentials.copySecret')}
                copiedMessage={t('applications.credentials.secretCopied')}
              />
            </View>
          ) : null}
          {/* The machine credential's single bearer string: its own box and label,
              so it can never be mistaken for the OAuth secret above. */}
          {revealed.token ? (
            <View className="gap-1">
              <Text className="text-xs text-muted-foreground">
                {t('applications.credentials.apiKeyLabel')}
              </Text>
              <CopyValue
                value={revealed.token}
                label={t('applications.credentials.copyApiKey')}
                copiedMessage={t('applications.credentials.apiKeyCopied')}
              />
            </View>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            <Button appearance="outline" size="sm" onPress={() => setRevealed(null)}>
              {t('applications.credentials.saved')}
            </Button>
            {/* Offered only for a machine credential's `token`: the `secret` above
                belongs to an OAuth client and is not an `oxy_sk_…` bearer, so it
                cannot authenticate the inference edge. The key is handed over in
                MEMORY (never a URL, never storage). */}
            {revealed.token ? (
              <Button
                appearance="outline"
                size="sm"
                onPress={() => {
                  setPlaygroundKey(revealed.token ?? '');
                  router.push('/playground' as Href);
                }}
              >
                {t('applications.credentials.tryPlayground')}
              </Button>
            ) : null}
          </View>
        </Notice>
      ) : null}

      {isLoading ? (
        <View className="gap-2">
          {[1, 2].map((key) => (
            <Skeleton.Box key={key} width="100%" height={64} borderRadius={14} />
          ))}
        </View>
      ) : credentials.length === 0 ? (
        <EmptyState
          variant="compact"
          icon={RiKey2Line}
          title={t('applications.credentials.empty')}
        />
      ) : (
        <RowGroup>
          {credentials.map((credential, index) => (
            <View key={credential._id} className={index > 0 ? 'border-t border-border' : undefined}>
              <View className="flex-row items-center justify-between gap-4 px-4 py-3">
                <View className="min-w-0 flex-1 gap-1">
                  <View className="flex-row flex-wrap items-center gap-2">
                    <Text numberOfLines={1} className="text-sm font-medium text-foreground">
                      {credential.name}
                    </Text>
                    <Badge
                      content={credential.status}
                      size="label-small"
                      variant={credential.status === 'active' ? 'solid' : 'subtle'}
                      color={
                        credential.status === 'active'
                          ? 'success'
                          : credential.status === 'revoked'
                            ? 'error'
                            : 'default'
                      }
                    />
                    <Badge
                      content={credential.type}
                      size="label-small"
                      variant="outlined"
                      color="default"
                    />
                    <Badge
                      content={credential.environment}
                      size="label-small"
                      variant="subtle"
                      color="default"
                    />
                  </View>
                  {/* For an API key the identifier a developer recognises is its
                      `oxy_sk_` prefix, not the OAuth client id it also carries.
                      Both are public; neither is the key. */}
                  <CopyValue
                    value={credential.tokenPrefix ?? credential.publicKey}
                    label={
                      credential.tokenPrefix
                        ? t('applications.credentials.copyApiKeyId')
                        : t('applications.credentials.copyClientId')
                    }
                    copiedMessage={
                      credential.tokenPrefix
                        ? t('applications.credentials.apiKeyIdCopied')
                        : t('applications.credentials.clientIdCopied')
                    }
                  />
                </View>

                <View className="flex-row items-center gap-1">
                  {canRotate && credential.status !== 'revoked' ? (
                    <Button
                      iconOnly
                      size="sm"
                      appearance="plain"
                      leadingIcon={RiRefreshLine}
                      accessibilityLabel={t('applications.credentials.rotate')}
                      onPress={() => setCredentialToRotate(credential)}
                    />
                  ) : null}
                  {canRevoke && credential.status !== 'revoked' ? (
                    <Button
                      iconOnly
                      size="sm"
                      appearance="plain"
                      tone="danger"
                      leadingIcon={RiDeleteBinLine}
                      accessibilityLabel={t('applications.credentials.revoke')}
                      onPress={() => setCredentialToRevoke(credential)}
                    />
                  ) : null}
                  {/* Gated on the same `credentials:read` the endpoint enforces. A
                      revoked credential keeps its trail: the revocation is the part
                      worth reading. */}
                  <Button
                    size="sm"
                    appearance="plain"
                    onPress={() => setTrailFor(trailFor === credential._id ? null : credential._id)}
                  >
                    {trailFor === credential._id
                      ? t('applications.credentials.hideTrail')
                      : t('applications.credentials.trail')}
                  </Button>
                </View>
              </View>
              {trailFor === credential._id ? (
                <CredentialTrail appId={appId} credentialId={credential._id} />
              ) : null}
            </View>
          ))}
        </RowGroup>
      )}

      <Dialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        placement={{ base: 'bottom', md: 'center' }}
        title={t('applications.credentials.createTitle')}
        description={t('applications.credentials.createBody')}
        actions={[
          { label: t('common.cancel'), color: 'cancel', disabled: createCredential.isPending },
          {
            label: t('applications.credentials.create'),
            onPress: () => void handleCreate(),
            disabled: createBlocked,
            loading: createCredential.isPending,
            shouldCloseOnPress: false,
          },
        ]}
        testID="create-credential-dialog"
      >
        <View className="gap-4">
          <TextInputField
            label={t('applications.credentials.name')}
            value={name}
            onChangeText={setName}
            placeholder={t('applications.credentials.namePlaceholder')}
            autoCapitalize="sentences"
          />
          <ChoiceSelect
            label={t('applications.credentials.type')}
            value={type}
            onChange={handleTypeChange}
            items={CREDENTIAL_TYPES.map((value) => ({
              value,
              label: t(`applications.credentials.types.${value}`),
            }))}
          />
          {type === 'service' ? (
            <View className="gap-2">
              <Text className="text-sm font-medium text-foreground">
                {t('applications.credentials.scopes')}
              </Text>
              {grantablePaymentsScopes.length > 0 ? (
                <View className="gap-3 rounded-lg border border-border p-3">
                  {PAYMENTS_SCOPES.filter((scope) => grantablePaymentsScopes.includes(scope)).map(
                    (scope) => (
                      <SwitchRow
                        key={scope}
                        title={scope}
                        description={
                          scope === 'payments:read'
                            ? t('applications.scopes.paymentsRead')
                            : t('applications.scopes.paymentsWrite')
                        }
                        checked={selectedScopes.includes(scope)}
                        onCheckedChange={(checked) => toggleScope(scope, checked)}
                      />
                    ),
                  )}
                </View>
              ) : (
                <Text className="text-sm text-muted-foreground">
                  {t('applications.credentials.enablePayments')}
                </Text>
              )}
              {requiresPaymentsScopes ? (
                <Text className="text-xs text-muted-foreground">
                  {t('applications.credentials.thirdPartyPayments')}
                </Text>
              ) : null}
            </View>
          ) : null}
          {isMachineType ? (
            <View className="gap-2">
              <Text className="text-sm font-medium text-foreground">
                {t('applications.credentials.scopes')}
              </Text>
              {application.scopes.length > 0 ? (
                <View className="gap-3 rounded-lg border border-border p-3">
                  {application.scopes.map((scope) => (
                    <SwitchRow
                      key={scope}
                      title={scope}
                      checked={selectedScopes.includes(scope)}
                      onCheckedChange={(checked) => toggleScope(scope, checked)}
                    />
                  ))}
                </View>
              ) : (
                <Text className="text-sm text-muted-foreground">
                  {t('applications.credentials.grantScopeFirst')}
                </Text>
              )}
              <Text className="text-xs text-muted-foreground">
                {t('applications.credentials.apiKeyHint')}
              </Text>
            </View>
          ) : null}
          <ChoiceSelect
            label={t('applications.credentials.environment')}
            value={environment}
            onChange={setEnvironment}
            items={ENVIRONMENTS.map((value) => ({
              value,
              label: t(`applications.credentials.environments.${value}`),
            }))}
          />
        </View>
      </Dialog>

      <Dialog
        open={credentialToRotate !== null}
        onClose={() => setCredentialToRotate(null)}
        placement={{ base: 'bottom', md: 'center' }}
        title={t('applications.credentials.rotateTitle')}
        description={t('applications.credentials.rotateBody', {
          name: credentialToRotate?.name ?? '',
        })}
        actions={[
          { label: t('common.cancel'), color: 'cancel', disabled: rotateCredential.isPending },
          {
            label: t('applications.credentials.rotateConfirm'),
            onPress: () => void handleRotate(),
            loading: rotateCredential.isPending,
            shouldCloseOnPress: false,
          },
        ]}
      />

      <Dialog
        open={credentialToRevoke !== null}
        onClose={() => setCredentialToRevoke(null)}
        placement={{ base: 'bottom', md: 'center' }}
        title={t('applications.credentials.revokeTitle')}
        description={t('applications.credentials.revokeBody', {
          name: credentialToRevoke?.name ?? '',
        })}
        actions={[
          { label: t('common.cancel'), color: 'cancel', disabled: revokeCredential.isPending },
          {
            label: t('applications.credentials.revokeConfirm'),
            color: 'destructive',
            onPress: () => void handleRevoke(),
            loading: revokeCredential.isPending,
            shouldCloseOnPress: false,
          },
        ]}
      />
    </View>
  );
}
