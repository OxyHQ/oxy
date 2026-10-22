import { useState } from 'react';
import { Text, View } from 'react-native';
import type { InferenceEnvironment } from '@oxy.so/contracts';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiCloudLine } from '@oxy.so/bloom/icons/RiCloudLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import type { ProviderConnectionView } from '@/lib/provider-connection';
import { useAccount } from '@/hooks/use-account';
import {
  useAccountProviderConnections,
  useCreateApplicationProviderConnection,
  useProviderConnectionAudit,
  useProviderCredentialValidation,
  useProviderValidationDeployments,
  useReconcileProviderConnection,
  useRevokeProviderConnection,
  useRotateProviderConnection,
  useSetProviderConnectionEnabled,
  useStartProviderCredentialValidation,
} from '@/hooks/use-provider-connections';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import {
  connectionAppliesToApplication,
  connectionStatusVariant,
  isKaanaCredentialControlUnavailable,
  providerConnectionAuditAttribution,
  providerConnectionScopeLabel,
} from '@/lib/provider-connection';
import {
  formatDate,
  formatDateTime,
  MutedText,
  NoPermission,
  Notice,
  Panel,
  PanelRow,
  Pill,
  SectionHeader,
  SelectField,
  TextInputField,
} from './ui';

/**
 * BYOK — the customer's own upstream provider credentials, as they apply to one
 * application.
 *
 * Three things this section is careful about:
 *
 *  - **It never shows a secret or internal execution handle.**
 *    `toProviderConnectionView` drops the opaque Kaana reference in the query's
 *    `select`, so it is gone before any component sees it. No prefix or digest
 *    derived from the credential is rendered.
 *  - **"Kaana custody is unavailable" is a state, not an error.** The API
 *    answers `503 kaana_credential_control_unavailable` before the parsed
 *    credential is validated or handed to a service. Console renders that as a
 *    standing explanation with no retry, because retrying changes nothing.
 *  - **Disable and revoke keep working when create and rotate do not.** Those
 *    two are pure database work on the server, which is the point: taking a
 *    credential out of service must not depend on the availability of the thing
 *    you are trying to stop using.
 *
 * Every affordance is gated on the same narrow server-supplied permission its API
 * route requires: `inference:byok:write` for an application connection and
 * `inference:providers:write` for an account connection. Reads require
 * `inference:providers:read`. All three go through typed predicates rather than
 * comparing `callerMembership.permissions` directly, because that field is
 * `string[]` and a misspelt literal in an inline comparison answers false forever.
 */
const ENVIRONMENTS: ReadonlyArray<InferenceEnvironment> = ['development', 'staging', 'production'];

export function ProviderConnectionsSection({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const { accounts, canReadProviderConnections, canManageProviderConnections } = useAccount();
  const ownerAccountId = application.ownerAccountId;
  const ownerAccount = accounts.find((account) => account.accountId === ownerAccountId);
  const canReadOwnerAccount =
    ownerAccount !== undefined && canReadProviderConnections(ownerAccount);
  const canUpdateOwnerAccount =
    ownerAccount !== undefined && canManageProviderConnections(ownerAccount);
  const canUpdateApplication = access.can('inference:byok:write');

  const {
    data: connections = [],
    isLoading,
    isError,
    error,
  } = useAccountProviderConnections(ownerAccountId, canReadOwnerAccount);

  const createConnection = useCreateApplicationProviderConnection();
  const rotateConnection = useRotateProviderConnection();
  const reconcileConnection = useReconcileProviderConnection();
  const setEnabled = useSetProviderConnectionEnabled();
  const revokeConnection = useRevokeProviderConnection();
  const startValidation = useStartProviderCredentialValidation();

  /**
   * The API's own sentence explaining why this deployment cannot hold a
   * credential, once a write has actually established it. Deliberately not
   * assumed up front: claiming "unavailable" without having been told so would be
   * a guess that reads exactly like a fact.
   */
  const [storeUnavailable, setStoreUnavailable] = useState<string | null>(null);

  const [showConnect, setShowConnect] = useState(false);
  const [provider, setProvider] = useState('');
  const [environment, setEnvironment] = useState<InferenceEnvironment>('development');
  const [acknowledgeTerms, setAcknowledgeTerms] = useState(false);
  const [secret, setSecret] = useState('');

  const [rotating, setRotating] = useState<ProviderConnectionView | null>(null);
  const [rotationSecret, setRotationSecret] = useState('');
  const [recovering, setRecovering] = useState<ProviderConnectionView | null>(null);
  const [recoverySecret, setRecoverySecret] = useState('');
  const [revoking, setRevoking] = useState<ProviderConnectionView | null>(null);
  const [validating, setValidating] = useState<ProviderConnectionView | null>(null);
  const [validationDeploymentId, setValidationDeploymentId] = useState('');
  const [trailFor, setTrailFor] = useState<string | null>(null);

  const validationDeployments = useProviderValidationDeployments(
    validating?.connectionId,
    application._id,
    validating !== null,
  );

  const applicable = connections.filter((connection) =>
    connectionAppliesToApplication(connection, application._id, ownerAccountId),
  );

  /** Which permission governs this connection is decided by ITS scope, as on the server. */
  const canManage = (connection: ProviderConnectionView): boolean =>
    connection.scope.kind === 'application' ? canUpdateApplication : canUpdateOwnerAccount;

  const custodyUnavailableMessage = (cause: unknown) =>
    getErrorMessage(cause, t('appsInference.byok.custodyUnavailableFallback'));

  const closeConnectDialog = () => {
    setShowConnect(false);
    setProvider('');
    setEnvironment('development');
    setAcknowledgeTerms(false);
    // The credential leaves component state the moment the dialog closes,
    // whatever the outcome.
    setSecret('');
  };

  const closeRotateDialog = () => {
    setRotating(null);
    setRotationSecret('');
  };

  const closeValidationDialog = () => {
    setValidating(null);
    setValidationDeploymentId('');
  };

  const closeRecoveryDialog = () => {
    setRecovering(null);
    setRecoverySecret('');
  };

  const handleConnect = async () => {
    try {
      const created = await createConnection.mutateAsync({
        applicationId: application._id,
        ownerAccountId,
        provider: provider.trim(),
        environment,
        secret,
        acknowledgeProviderTerms: acknowledgeTerms,
      });
      closeConnectDialog();
      setValidationDeploymentId('');
      setValidating(created);
      toast.success(t('appsInference.byok.connect.created'));
    } catch (connectError) {
      setSecret('');
      if (isKaanaCredentialControlUnavailable(connectError)) {
        setStoreUnavailable(custodyUnavailableMessage(connectError));
        setShowConnect(false);
        return;
      }
      toast.error(getErrorMessage(connectError, t('appsInference.byok.connect.failed')));
    }
  };

  const handleRotate = async () => {
    if (!rotating) {
      return;
    }
    try {
      const rotated = await rotateConnection.mutateAsync({
        connectionId: rotating.connectionId,
        ownerAccountId,
        secret: rotationSecret,
      });
      closeRotateDialog();
      setValidationDeploymentId('');
      setValidating(rotated);
      toast.success(t('appsInference.byok.rotate.done'));
    } catch (rotateError) {
      setRotationSecret('');
      if (isKaanaCredentialControlUnavailable(rotateError)) {
        setStoreUnavailable(custodyUnavailableMessage(rotateError));
        setRotating(null);
        return;
      }
      toast.error(getErrorMessage(rotateError, t('appsInference.byok.rotate.failed')));
    }
  };

  const handleSetEnabled = async (connection: ProviderConnectionView, enabled: boolean) => {
    try {
      await setEnabled.mutateAsync({
        connectionId: connection.connectionId,
        ownerAccountId,
        enabled,
      });
      toast.success(
        enabled ? t('appsInference.byok.enabled') : t('appsInference.byok.disabledToast'),
      );
    } catch (toggleError) {
      toast.error(
        getErrorMessage(
          toggleError,
          enabled ? t('appsInference.byok.enableFailed') : t('appsInference.byok.disableFailed'),
        ),
      );
    }
  };

  const handleValidate = async () => {
    if (!validating || validationDeploymentId === '') return;
    try {
      const operation = await startValidation.mutateAsync({
        connectionId: validating.connectionId,
        ownerAccountId,
        applicationId: application._id,
        deploymentId: validationDeploymentId,
      });
      closeValidationDialog();
      toast.success(
        operation.state === 'pending'
          ? t('appsInference.byok.validate.queued')
          : t('appsInference.byok.validate.state', { state: operation.state }),
      );
    } catch (validationError) {
      toast.error(getErrorMessage(validationError, t('appsInference.byok.validate.failed')));
    }
  };

  const handleRecover = async () => {
    if (!recovering) return;
    try {
      await reconcileConnection.mutateAsync({
        connectionId: recovering.connectionId,
        ownerAccountId,
        secret: recoverySecret.length === 0 ? undefined : recoverySecret,
      });
      closeRecoveryDialog();
      toast.success(t('appsInference.byok.recover.done'));
    } catch (recoveryError) {
      setRecoverySecret('');
      if (isKaanaCredentialControlUnavailable(recoveryError)) {
        setStoreUnavailable(custodyUnavailableMessage(recoveryError));
        setRecovering(null);
        return;
      }
      toast.error(getErrorMessage(recoveryError, t('appsInference.byok.recover.pending')));
    }
  };

  const handleRevoke = async () => {
    if (!revoking) {
      return;
    }
    try {
      await revokeConnection.mutateAsync({
        connectionId: revoking.connectionId,
        ownerAccountId,
      });
      setRevoking(null);
      toast.success(t('appsInference.byok.revoke.done'));
    } catch (revokeError) {
      toast.error(getErrorMessage(revokeError, t('appsInference.byok.revoke.failed')));
    }
  };

  if (!canReadOwnerAccount) {
    return <NoPermission>{t('appsInference.byok.noPermission')}</NoPermission>;
  }

  const deployments = validationDeployments.data ?? [];

  return (
    <View className="gap-6">
      <SectionHeader
        title={t('appsInference.byok.title')}
        description={t('appsInference.byok.description')}
        action={
          canUpdateApplication && storeUnavailable === null ? (
            <Button size="sm" onPress={() => setShowConnect(true)}>
              {t('appsInference.byok.connect.open')}
            </Button>
          ) : undefined
        }
      />

      {storeUnavailable !== null && (
        <Notice title={t('appsInference.byok.unavailable.title')}>
          {`${storeUnavailable}\n\n${t('appsInference.byok.unavailable.body')}`}
        </Notice>
      )}

      <Notice title={t('appsInference.byok.terms.title')}>
        {t('appsInference.byok.terms.body')}
      </Notice>

      {isError ? (
        <Notice type="error" title={t('appsInference.byok.loadFailedTitle')}>
          {getErrorMessage(error, t('appsInference.byok.loadFailedFallback'))}
        </Notice>
      ) : isLoading ? (
        <Skeleton.Box width="100%" height={120} borderRadius={14} />
      ) : applicable.length === 0 ? (
        <EmptyState
          icon={RiCloudLine}
          variant="compact"
          title={t('appsInference.byok.empty.title')}
          description={t('appsInference.byok.empty.body')}
        />
      ) : (
        <View className="gap-3">
          {applicable.map((connection) => (
            <ConnectionCard
              key={connection.connectionId}
              connection={connection}
              applicationId={application._id}
              canManage={canManage(connection)}
              storeUnavailable={storeUnavailable !== null}
              isTrailOpen={trailFor === connection.connectionId}
              onToggleTrail={() =>
                setTrailFor((current) =>
                  current === connection.connectionId ? null : connection.connectionId,
                )
              }
              onRotate={() => {
                setRotationSecret('');
                setRotating(connection);
              }}
              onRecover={() => {
                setRecoverySecret('');
                setRecovering(connection);
              }}
              onValidate={() => {
                setValidationDeploymentId('');
                setValidating(connection);
              }}
              onSetEnabled={(enabled) => handleSetEnabled(connection, enabled)}
              onRevoke={() => setRevoking(connection)}
            />
          ))}
        </View>
      )}

      {/* Connect */}
      <Dialog
        open={showConnect}
        onClose={closeConnectDialog}
        title={t('appsInference.byok.connect.title')}
        description={t('appsInference.byok.connect.description')}
        actions={[
          {
            label: createConnection.isPending
              ? t('appsInference.byok.connect.connecting')
              : t('appsInference.byok.connect.submit'),
            loading: createConnection.isPending,
            disabled: provider.trim() === '' || secret.length === 0,
            shouldCloseOnPress: false,
            onPress: handleConnect,
          },
          { label: t('common.cancel'), color: 'cancel' },
        ]}
      >
        <View className="gap-4">
          <TextInputField
            label={t('appsInference.byok.connect.provider')}
            value={provider}
            onChange={(value) => setProvider(value.toLowerCase())}
            placeholder="provider-slug"
            help={t('appsInference.byok.connect.providerHelp')}
          />
          <SelectField
            label={t('appsInference.byok.connect.environment')}
            value={environment}
            onChange={setEnvironment}
            items={ENVIRONMENTS.map((value) => ({
              value,
              label: t(`appsInference.byok.environments.${value}`),
            }))}
          />
          <View className="flex-row items-start justify-between gap-4">
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-medium text-foreground">
                {t('appsInference.byok.connect.acceptTerms')}
              </Text>
              <MutedText small>{t('appsInference.byok.connect.acceptTermsHelp')}</MutedText>
            </View>
            <Switch
              checked={acknowledgeTerms}
              onCheckedChange={setAcknowledgeTerms}
              accessibilityLabel={t('appsInference.byok.connect.acceptTerms')}
            />
          </View>
          <TextInputField
            label={t('appsInference.byok.connect.credential')}
            value={secret}
            onChange={setSecret}
            secret
          />
        </View>
      </Dialog>

      {/* Explicit exact bootstrap/revalidation; no deployment is preselected. */}
      <Dialog
        open={validating !== null}
        onClose={closeValidationDialog}
        title={t('appsInference.byok.validate.title')}
        description={t('appsInference.byok.validate.description')}
        actions={[
          {
            label: startValidation.isPending
              ? t('appsInference.byok.validate.starting')
              : t('appsInference.byok.validate.start'),
            loading: startValidation.isPending,
            disabled: validationDeploymentId === '',
            shouldCloseOnPress: false,
            onPress: handleValidate,
          },
          { label: t('common.cancel'), color: 'cancel' },
        ]}
      >
        <View className="gap-2">
          <SelectField
            label={t('appsInference.byok.validate.deployment')}
            value={validationDeploymentId}
            onChange={setValidationDeploymentId}
            placeholder={t('appsInference.byok.validate.selectDeployment')}
            items={deployments.map((deployment) => ({
              value: deployment.deploymentId,
              label: deployment.deploymentId,
            }))}
          />
          {validationDeployments.isLoading && (
            <MutedText small>{t('appsInference.byok.validate.loadingDeployments')}</MutedText>
          )}
          {!validationDeployments.isLoading && deployments.length === 0 && (
            <MutedText small>{t('appsInference.byok.validate.noDeployments')}</MutedText>
          )}
          <MutedText small>{t('appsInference.byok.validate.outcomes')}</MutedText>
        </View>
      </Dialog>

      {/* Rotate */}
      <Dialog
        open={rotating !== null}
        onClose={closeRotateDialog}
        title={t('appsInference.byok.rotate.title')}
        description={t('appsInference.byok.rotate.description')}
        actions={[
          {
            label: rotateConnection.isPending
              ? t('appsInference.byok.rotate.rotating')
              : t('appsInference.byok.rotate.submit'),
            loading: rotateConnection.isPending,
            disabled: rotationSecret.length === 0,
            shouldCloseOnPress: false,
            onPress: handleRotate,
          },
          { label: t('common.cancel'), color: 'cancel' },
        ]}
      >
        <TextInputField
          label={t('appsInference.byok.rotate.newCredential')}
          value={rotationSecret}
          onChange={setRotationSecret}
          secret
        />
      </Dialog>

      {/* Recover an outcome-uncertain create, rotate or revoke. */}
      <Dialog
        open={recovering !== null}
        onClose={closeRecoveryDialog}
        title={t('appsInference.byok.recover.title')}
        description={t('appsInference.byok.recover.description')}
        actions={[
          {
            label: reconcileConnection.isPending
              ? t('appsInference.byok.recover.recovering')
              : t('appsInference.byok.recover.submit'),
            loading: reconcileConnection.isPending,
            shouldCloseOnPress: false,
            onPress: handleRecover,
          },
          { label: t('common.cancel'), color: 'cancel' },
        ]}
      >
        <TextInputField
          label={t('appsInference.byok.recover.credential')}
          value={recoverySecret}
          onChange={setRecoverySecret}
          secret
        />
      </Dialog>

      {/* Revoke */}
      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={t('appsInference.byok.revoke.title')}
        description={t('appsInference.byok.revoke.description')}
        actions={[
          {
            label: revokeConnection.isPending
              ? t('appsInference.byok.revoke.revoking')
              : t('appsInference.byok.revoke.submit'),
            color: 'destructive',
            loading: revokeConnection.isPending,
            shouldCloseOnPress: false,
            onPress: handleRevoke,
          },
          { label: t('common.cancel'), color: 'cancel' },
        ]}
      />
    </View>
  );
}

function ConnectionCard({
  connection,
  applicationId,
  canManage,
  storeUnavailable,
  isTrailOpen,
  onToggleTrail,
  onRotate,
  onRecover,
  onValidate,
  onSetEnabled,
  onRevoke,
}: {
  connection: ProviderConnectionView;
  applicationId: string;
  canManage: boolean;
  storeUnavailable: boolean;
  isTrailOpen: boolean;
  onToggleTrail: () => void;
  onRotate: () => void;
  onRecover: () => void;
  onValidate: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onRevoke: () => void;
}) {
  const { t } = useTranslation();
  const isRevoked = connection.status === 'revoked';
  const { data: validationOperation } = useProviderCredentialValidation(
    connection.connectionId,
    applicationId,
  );

  return (
    <Panel>
      <View className="flex-row flex-wrap items-start justify-between gap-3 px-4 py-3">
        <View className="min-w-0 flex-1 gap-1.5">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="text-sm font-medium text-foreground">{connection.provider}</Text>
            <Pill label={connection.status} tone={connectionStatusVariant(connection.status)} />
            <Pill label={connection.environment} tone="outline" />
            <Pill label={connection.validation.state} tone="ghost" />
            {connection.custodyState === 'reconcile' && (
              <Pill label={t('appsInference.byok.card.recoveryNeeded')} tone="destructive" />
            )}
          </View>
          <MutedText small>{providerConnectionScopeLabel(connection.scope)}</MutedText>
          {validationOperation && (
            <MutedText small>
              {t('appsInference.byok.card.lastBootstrap', {
                state: validationOperation.state,
                deployment: validationOperation.deploymentId,
                failure: validationOperation.failureCode
                  ? ` · ${validationOperation.failureCode}`
                  : '',
              })}
            </MutedText>
          )}
          <Text className="font-mono text-xs text-muted-foreground">
            {t('appsInference.byok.card.hidden')}
          </Text>
          <MutedText small>
            {t('appsInference.byok.card.connected', { date: formatDate(connection.createdAt) })}
            {connection.rotatedAt
              ? t('appsInference.byok.card.rotated', { date: formatDate(connection.rotatedAt) })
              : ''}
            {connection.validation.failureCode
              ? t('appsInference.byok.card.checkFailed', {
                  code: connection.validation.failureCode,
                })
              : ''}
          </MutedText>
        </View>

        <View className="shrink-0 flex-row flex-wrap items-center gap-1">
          <Button appearance="plain" size="sm" onPress={onToggleTrail}>
            {isTrailOpen
              ? t('appsInference.byok.card.hideTrail')
              : t('appsInference.byok.card.trail')}
          </Button>
          {canManage && connection.custodyState === 'reconcile' && !storeUnavailable && (
            <Button appearance="outline" size="sm" onPress={onRecover}>
              {t('appsInference.byok.card.recover')}
            </Button>
          )}
          {canManage && !isRevoked && (
            <>
              <Button appearance="outline" size="sm" onPress={onValidate}>
                {connection.validation.state === 'valid'
                  ? t('appsInference.byok.card.revalidate')
                  : t('appsInference.byok.card.validate')}
              </Button>
              {/* Rotation writes a credential, so it is unavailable for the same
                  reason connecting one is. Disable and revoke are not. */}
              {!storeUnavailable && (
                <Button appearance="plain" size="sm" onPress={onRotate}>
                  {t('appsInference.byok.card.rotate')}
                </Button>
              )}
              <Button
                appearance="plain"
                size="sm"
                onPress={() => onSetEnabled(connection.status === 'disabled')}
              >
                {connection.status === 'disabled'
                  ? t('appsInference.byok.card.enable')
                  : t('appsInference.byok.card.disable')}
              </Button>
              <Button appearance="plain" tone="danger" size="sm" onPress={onRevoke}>
                {t('appsInference.byok.card.revoke')}
              </Button>
            </>
          )}
        </View>
      </View>

      {isTrailOpen && <ConnectionTrail connectionId={connection.connectionId} />}
    </Panel>
  );
}

/**
 * A connection's append-only trail.
 *
 * The event's stored `metadata` is deliberately not rendered: it is an open
 * shape written by several code paths, and a screen that prints whatever it
 * finds there is a screen whose safety depends on every future writer.
 */
function ConnectionTrail({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const { data: events = [], isLoading } = useProviderConnectionAudit(connectionId);

  if (isLoading) {
    return (
      <PanelRow>
        <Skeleton.Box width="100%" height={60} borderRadius={10} />
      </PanelRow>
    );
  }

  if (events.length === 0) {
    return (
      <PanelRow>
        <MutedText>{t('appsInference.byok.trail.empty')}</MutedText>
      </PanelRow>
    );
  }

  return (
    <View>
      {events.map((event) => (
        <PanelRow key={`${event.eventType}-${event.createdAt}`} className="py-2">
          <View className="flex-row flex-wrap items-center justify-between gap-2">
            <View className="flex-row items-center gap-2">
              <Pill label={event.eventType} tone="outline" />
              <MutedText small>
                {`${event.environment} · ${providerConnectionAuditAttribution(event)}`}
              </MutedText>
            </View>
            <MutedText small>{formatDateTime(event.createdAt)}</MutedText>
          </View>
        </PanelRow>
      ))}
    </View>
  );
}
