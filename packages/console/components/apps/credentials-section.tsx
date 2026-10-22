import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import {
  Card,
  CardBody,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@oxy.so/bloom/card';
import { CodeBlock } from '@oxy.so/bloom/code';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Field } from '@oxy.so/bloom/field';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { RiKey2Line } from '@oxy.so/bloom/icons/RiKey2Line';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { Item } from '@oxy.so/bloom/item';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { type Href, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

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
import { copyText } from '@/lib/clipboard';
import {
  availablePaymentsScopes,
  isUntrustedThirdPartyApp,
  PAYMENTS_SCOPES,
} from '@/lib/application-scopes';
import { useTranslation } from '@/lib/i18n';
import { usePlaygroundKey } from '@/lib/playground-key';
import { CredentialTrail } from './credential-trail';

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
      <EmptyState
        variant="compact"
        icon={RiKey2Line}
        title={t('applications.credentials.noPermission')}
      />
    );
  }

  const copyable = (code: string, label: string, message: string) => (
    <CodeBlock
      code={code}
      filename={label}
      lineNumbers={false}
      wrap
      onCopy={() => copyText(code, message)}
    />
  );

  return (
    <View className="gap-6">
      <Card appearance="outline">
        <CardHeader>
          <View className="flex-row items-start justify-between gap-3">
            <View className="min-w-0 flex-1 gap-1">
              <CardTitle>{t('applications.credentials.title')}</CardTitle>
              <CardDescription>{t('applications.credentials.subtitle')}</CardDescription>
            </View>
            {canCreate ? (
              <Button
                leadingIcon={RiAddLine}
                onPress={() => {
                  resetCreateForm();
                  setShowCreateDialog(true);
                }}
              >
                {t('applications.credentials.create')}
              </Button>
            ) : null}
          </View>
        </CardHeader>
      </Card>

      {/* Revealed secret — shown once */}
      {revealed ? (
        <Card appearance="outline">
          <CardHeader>
            <CardTitle>
              {t('applications.credentials.saveSecret', { name: revealed.credentialName })}
            </CardTitle>
          </CardHeader>
          <CardBody>
            <View className="gap-3">
              <Admonition type="warning">{t('applications.credentials.shownOnce')}</Admonition>
              {copyable(
                revealed.publicKey,
                t('applications.credentials.clientId'),
                t('applications.credentials.clientIdCopied'),
              )}
              {/* Rendered ONLY when the credential actually has one. A `public`
                  client's `secret` is null and a machine credential's is too —
                  without this guard the box would show an empty value and the copy
                  would put the string "null" on the clipboard. */}
              {revealed.secret
                ? copyable(
                    revealed.secret,
                    t('applications.credentials.secret'),
                    t('applications.credentials.secretCopied'),
                  )
                : null}
              {/* The machine credential's single bearer string: its own box and label,
                  so it can never be mistaken for the OAuth secret above. */}
              {revealed.token
                ? copyable(
                    revealed.token,
                    t('applications.credentials.apiKeyLabel'),
                    t('applications.credentials.apiKeyCopied'),
                  )
                : null}
            </View>
          </CardBody>
          <CardFooter>
            {/* Offered only for a machine credential's `token`: the `secret` above
                belongs to an OAuth client and is not an `oxy_sk_…` bearer, so it
                cannot authenticate the inference edge. The key is handed over in
                MEMORY (never a URL, never storage). */}
            {revealed.token ? (
              <Button
                appearance="outline"
                onPress={() => {
                  setPlaygroundKey(revealed.token ?? '');
                  router.push('/playground' as Href);
                }}
              >
                {t('applications.credentials.tryPlayground')}
              </Button>
            ) : null}
            <Button appearance="outline" onPress={() => setRevealed(null)}>
              {t('applications.credentials.saved')}
            </Button>
          </CardFooter>
        </Card>
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
        <Card appearance="outline">
          {credentials.map((credential) => (
            <View key={credential._id}>
              {/* For an API key the identifier a developer recognises is its
                  `oxy_sk_` prefix, not the OAuth client id it also carries.
                  Both are public; neither is the key. */}
              <Item
                title={credential.name}
                subtitle={credential.tokenPrefix ?? credential.publicKey}
                trailing={
                  <View className="flex-row flex-wrap items-center justify-end gap-1">
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
                    <Button
                      iconOnly
                      size="sm"
                      appearance="plain"
                      leadingIcon={RiFileCopyLine}
                      accessibilityLabel={
                        credential.tokenPrefix
                          ? t('applications.credentials.copyApiKeyId')
                          : t('applications.credentials.copyClientId')
                      }
                      onPress={() =>
                        void copyText(
                          credential.tokenPrefix ?? credential.publicKey,
                          credential.tokenPrefix
                            ? t('applications.credentials.apiKeyIdCopied')
                            : t('applications.credentials.clientIdCopied'),
                        )
                      }
                    />
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
                      onPress={() =>
                        setTrailFor(trailFor === credential._id ? null : credential._id)
                      }
                    >
                      {trailFor === credential._id
                        ? t('applications.credentials.hideTrail')
                        : t('applications.credentials.trail')}
                    </Button>
                  </View>
                }
              />
              {trailFor === credential._id ? (
                <CredentialTrail appId={appId} credentialId={credential._id} />
              ) : null}
            </View>
          ))}
        </Card>
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
          <Field label={t('applications.credentials.name')}>
            <TextFieldInput
              label={t('applications.credentials.name')}
              value={name}
              onChangeText={setName}
              placeholder={t('applications.credentials.namePlaceholder')}
              autoCapitalize="sentences"
            />
          </Field>
          <Field label={t('applications.credentials.type')}>
            <Select
              value={type}
              onValueChange={(next) => handleTypeChange(next as ApplicationCredentialType)}
            >
              <SelectTrigger label={t('applications.credentials.type')}>
                <SelectValue />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent
                label={t('applications.credentials.type')}
                items={CREDENTIAL_TYPES.map((value) => ({
                  value,
                  label: t(`applications.credentials.types.${value}`),
                }))}
                renderItem={(item) => (
                  <SelectItem value={item.value} label={item.label}>
                    <SelectItemIndicator />
                    <SelectItemText>{item.label}</SelectItemText>
                  </SelectItem>
                )}
              />
            </Select>
          </Field>
          {type === 'service' ? (
            grantablePaymentsScopes.length > 0 ? (
              <GroupedSection
                title={t('applications.credentials.scopes')}
                footer={
                  requiresPaymentsScopes
                    ? t('applications.credentials.thirdPartyPayments')
                    : undefined
                }
              >
                {PAYMENTS_SCOPES.filter((scope) => grantablePaymentsScopes.includes(scope)).map(
                  (scope) => (
                    <GroupedSectionItem
                      key={scope}
                      title={scope}
                      description={
                        scope === 'payments:read'
                          ? t('applications.scopes.paymentsRead')
                          : t('applications.scopes.paymentsWrite')
                      }
                      rightElement={
                        <Switch
                          checked={selectedScopes.includes(scope)}
                          onCheckedChange={(checked) => toggleScope(scope, checked)}
                          accessibilityLabel={scope}
                        />
                      }
                    />
                  ),
                )}
              </GroupedSection>
            ) : (
              <Admonition type="info">{t('applications.credentials.enablePayments')}</Admonition>
            )
          ) : null}
          {isMachineType ? (
            application.scopes.length > 0 ? (
              <GroupedSection
                title={t('applications.credentials.scopes')}
                footer={t('applications.credentials.apiKeyHint')}
              >
                {application.scopes.map((scope) => (
                  <GroupedSectionItem
                    key={scope}
                    title={scope}
                    rightElement={
                      <Switch
                        checked={selectedScopes.includes(scope)}
                        onCheckedChange={(checked) => toggleScope(scope, checked)}
                        accessibilityLabel={scope}
                      />
                    }
                  />
                ))}
              </GroupedSection>
            ) : (
              <Admonition type="info">{t('applications.credentials.grantScopeFirst')}</Admonition>
            )
          ) : null}
          <Field label={t('applications.credentials.environment')}>
            <Select
              value={environment}
              onValueChange={(next) => setEnvironment(next as ApplicationEnvironment)}
            >
              <SelectTrigger label={t('applications.credentials.environment')}>
                <SelectValue />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent
                label={t('applications.credentials.environment')}
                items={ENVIRONMENTS.map((value) => ({
                  value,
                  label: t(`applications.credentials.environments.${value}`),
                }))}
                renderItem={(item) => (
                  <SelectItem value={item.value} label={item.label}>
                    <SelectItemIndicator />
                    <SelectItemText>{item.label}</SelectItemText>
                  </SelectItem>
                )}
              />
            </Select>
          </Field>
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
