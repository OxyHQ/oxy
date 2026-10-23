import { useState } from 'react';
import { Text, View } from 'react-native';
import type { InferenceEnvironment } from '@oxy.so/contracts';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import {
  DataTable,
  DataTableRowActions,
  type DataTableColumn,
  type DataTableRowActionItem,
} from '@oxy.so/bloom/data-table';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Field } from '@oxy.so/bloom/field';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Item } from '@oxy.so/bloom/item';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCloudLine } from '@oxy.so/bloom/icons/RiCloudLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiForbidLine } from '@oxy.so/bloom/icons/RiForbidLine';
import { RiHistoryLine } from '@oxy.so/bloom/icons/RiHistoryLine';
import { RiKey2Line } from '@oxy.so/bloom/icons/RiKey2Line';
import { RiLifebuoyLine } from '@oxy.so/bloom/icons/RiLifebuoyLine';
import { RiPlayCircleLine } from '@oxy.so/bloom/icons/RiPlayCircleLine';
import { RiShieldCheckLine } from '@oxy.so/bloom/icons/RiShieldCheckLine';
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
import { useAppDetail } from '@/components/apps/app-context';
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

const formatDate = (iso: string): string => new Date(iso).toLocaleDateString();
const formatDateTime = (iso: string): string => new Date(iso).toLocaleString();

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

export function ProviderConnections() {
  const { t } = useTranslation();
  const { application, access } = useAppDetail();
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
    return <EmptyState variant="compact" title={t('appsInference.byok.noPermission')} />;
  }

  const deployments = validationDeployments.data ?? [];

  const columns: Array<DataTableColumn<ProviderConnectionView>> = [
    {
      id: 'provider',
      header: t('appsInference.byok.columns.provider'),
      minWidth: 160,
      cell: ({ row }) => (
        <View className="gap-0.5">
          <Text className="text-sm font-medium text-foreground">{row.provider}</Text>
          <Text className="text-xs text-muted-foreground">
            {providerConnectionScopeLabel(row.scope)}
          </Text>
        </View>
      ),
    },
    {
      id: 'state',
      header: t('appsInference.byok.columns.state'),
      minWidth: 190,
      cell: ({ row }) => (
        <View className="flex-row flex-wrap items-center gap-1.5">
          <Badge
            content={humanise(row.status)}
            variant="subtle"
            color={statusColor(connectionStatusVariant(row.status))}
            size="label-small"
          />
          <Badge
            content={humanise(row.environment)}
            variant="outlined"
            color="default"
            size="label-small"
          />
          <Badge
            content={humanise(row.validation.state)}
            variant="subtle"
            color={validationColor(row.validation.state)}
            size="label-small"
          />
          {row.custodyState === 'reconcile' && (
            <Badge
              content={t('appsInference.byok.card.recoveryNeeded')}
              variant="subtle"
              color="error"
              size="label-small"
            />
          )}
        </View>
      ),
    },
    {
      id: 'details',
      header: t('appsInference.byok.columns.details'),
      minWidth: 210,
      cell: ({ row }) => <ConnectionDetails connection={row} applicationId={application._id} />,
    },
    {
      id: 'actions',
      header: '',
      headerAccessibilityLabel: t('appsInference.byok.columns.actions'),
      align: 'end',
      width: 96,
      cell: ({ row }) => {
        const manageable = canManage(row);
        const isRevoked = row.status === 'revoked';
        const menu: Array<DataTableRowActionItem> = [];
        if (manageable && row.custodyState === 'reconcile' && storeUnavailable === null) {
          menu.push({
            icon: RiLifebuoyLine,
            label: t('appsInference.byok.card.recover'),
            onPress: () => {
              setRecoverySecret('');
              setRecovering(row);
            },
          });
        }
        if (manageable && !isRevoked) {
          menu.push({
            icon: RiShieldCheckLine,
            label:
              row.validation.state === 'valid'
                ? t('appsInference.byok.card.revalidate')
                : t('appsInference.byok.card.validate'),
            onPress: () => {
              setValidationDeploymentId('');
              setValidating(row);
            },
          });
          // Rotation writes a credential, so it is unavailable for the same
          // reason connecting one is. Disable and revoke are not.
          if (storeUnavailable === null) {
            menu.push({
              icon: RiKey2Line,
              label: t('appsInference.byok.card.rotate'),
              onPress: () => {
                setRotationSecret('');
                setRotating(row);
              },
            });
          }
          menu.push(
            row.status === 'disabled'
              ? {
                  icon: RiPlayCircleLine,
                  label: t('appsInference.byok.card.enable'),
                  onPress: () => handleSetEnabled(row, true),
                }
              : {
                  icon: RiForbidLine,
                  label: t('appsInference.byok.card.disable'),
                  onPress: () => handleSetEnabled(row, false),
                },
            {
              icon: RiDeleteBinLine,
              label: t('appsInference.byok.card.revoke'),
              onPress: () => setRevoking(row),
            },
          );
        }
        return (
          <DataTableRowActions
            name={row.provider}
            menuLabel={t('appsInference.byok.card.actions')}
            actions={[
              {
                icon: RiHistoryLine,
                label: t('appsInference.byok.card.trail'),
                onPress: () => setTrailFor(row.connectionId),
              },
            ]}
            menu={menu}
          />
        );
      },
    },
  ];

  return (
    <>
      {storeUnavailable !== null && (
        <Admonition type="info">
          <Text className="font-semibold">{t('appsInference.byok.unavailable.title')}</Text>
          {`\n${storeUnavailable}\n\n${t('appsInference.byok.unavailable.body')}`}
        </Admonition>
      )}

      <Admonition type="info">
        <Text className="font-semibold">{t('appsInference.byok.terms.title')}</Text>
        {`\n${t('appsInference.byok.terms.body')}`}
      </Admonition>

      <Item
        title={t('appsInference.byok.title')}
        trailing={
          canUpdateApplication && storeUnavailable === null ? (
            <Button size="sm" icon={RiAddLine} onPress={() => setShowConnect(true)}>
              {t('appsInference.byok.connect.open')}
            </Button>
          ) : undefined
        }
      />
      <Text className="-mt-3 px-4 text-xs text-muted-foreground">
        {t('appsInference.byok.description')}
      </Text>

      {isError ? (
        <Admonition type="error">
          <Text className="font-semibold">{t('appsInference.byok.loadFailedTitle')}</Text>
          {`\n${getErrorMessage(error, t('appsInference.byok.loadFailedFallback'))}`}
        </Admonition>
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
        <DataTable
          rows={applicable}
          columns={columns}
          getRowId={(connection) => connection.connectionId}
          accessibilityLabel={t('appsInference.byok.title')}
          minWidth={640}
          size="sm"
        />
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
        <View className="gap-4 pb-4">
          <Field
            label={t('appsInference.byok.connect.provider')}
            description={t('appsInference.byok.connect.providerHelp')}
          >
            <TextFieldInput
              label={t('appsInference.byok.connect.provider')}
              value={provider}
              onValueChange={(value) => setProvider(value.toLowerCase())}
              placeholder="provider-slug"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Field label={t('appsInference.byok.connect.environment')}>
            <Select
              value={environment}
              onValueChange={(next) => setEnvironment(next as InferenceEnvironment)}
            >
              <SelectTrigger>
                <SelectValue>
                  {() => t(`appsInference.byok.environments.${environment}`)}
                </SelectValue>
                <SelectIcon />
              </SelectTrigger>
              <SelectContent
                label={t('appsInference.byok.connect.environment')}
                items={ENVIRONMENTS.map((value) => ({
                  value,
                  label: t(`appsInference.byok.environments.${value}`),
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
          <Field
            label={t('appsInference.byok.connect.acceptTerms')}
            description={t('appsInference.byok.connect.acceptTermsHelp')}
          >
            <Switch checked={acknowledgeTerms} onCheckedChange={setAcknowledgeTerms} />
          </Field>
          <Field label={t('appsInference.byok.connect.credential')}>
            <TextFieldInput
              label={t('appsInference.byok.connect.credential')}
              value={secret}
              onValueChange={setSecret}
              secureTextEntry
              revealable
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
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
        <View className="gap-2 pb-4">
          <Field
            label={t('appsInference.byok.validate.deployment')}
            description={
              validationDeployments.isLoading
                ? t('appsInference.byok.validate.loadingDeployments')
                : deployments.length === 0
                  ? t('appsInference.byok.validate.noDeployments')
                  : undefined
            }
          >
            <Select
              value={validationDeploymentId || undefined}
              onValueChange={setValidationDeploymentId}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('appsInference.byok.validate.selectDeployment')} />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent
                label={t('appsInference.byok.validate.deployment')}
                items={deployments.map((deployment) => ({
                  value: deployment.deploymentId,
                  label: deployment.deploymentId,
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
          <Text className="text-xs text-muted-foreground">
            {t('appsInference.byok.validate.outcomes')}
          </Text>
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
        <Field label={t('appsInference.byok.rotate.newCredential')}>
          <TextFieldInput
            label={t('appsInference.byok.rotate.newCredential')}
            value={rotationSecret}
            onValueChange={setRotationSecret}
            secureTextEntry
            revealable
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
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
        <Field label={t('appsInference.byok.recover.credential')}>
          <TextFieldInput
            label={t('appsInference.byok.recover.credential')}
            value={recoverySecret}
            onValueChange={setRecoverySecret}
            secureTextEntry
            revealable
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
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

      {/* A connection's append-only trail. */}
      <Dialog
        open={trailFor !== null}
        onClose={() => setTrailFor(null)}
        title={t('appsInference.byok.card.trail')}
        scrollable
        actions={[{ label: t('common.close'), color: 'cancel' }]}
      >
        {trailFor !== null && <ConnectionTrail connectionId={trailFor} />}
      </Dialog>
    </>
  );
}

/** The Bloom badge colour for the status vocabulary the lib helpers return. */
function statusColor(
  variant: 'default' | 'secondary' | 'destructive',
): 'success' | 'default' | 'error' {
  return variant === 'default' ? 'success' : variant === 'destructive' ? 'error' : 'default';
}

const humanise = (value: string): string => value.replaceAll('_', ' ');

function validationColor(state: string): 'success' | 'default' | 'error' | 'warning' {
  if (state === 'valid') return 'success';
  if (state === 'invalid' || state === 'expired') return 'error';
  if (state === 'unvalidated') return 'default';
  return 'warning';
}

/** What is known about a connection beyond its state: bootstrap, custody and dates. */
function ConnectionDetails({
  connection,
  applicationId,
}: {
  connection: ProviderConnectionView;
  applicationId: string;
}) {
  const { t } = useTranslation();
  const { data: validationOperation } = useProviderCredentialValidation(
    connection.connectionId,
    applicationId,
  );
  return (
    <View className="gap-0.5">
      {validationOperation && (
        <Text className="text-xs text-muted-foreground">
          {t('appsInference.byok.card.lastBootstrap', {
            state: validationOperation.state,
            deployment: validationOperation.deploymentId,
            failure: validationOperation.failureCode ? ` · ${validationOperation.failureCode}` : '',
          })}
        </Text>
      )}
      <Text className="font-mono text-xs text-muted-foreground">
        {t('appsInference.byok.card.hidden')}
      </Text>
      <Text className="text-xs text-muted-foreground">
        {t('appsInference.byok.card.connected', { date: formatDate(connection.createdAt) })}
        {connection.rotatedAt
          ? t('appsInference.byok.card.rotated', { date: formatDate(connection.rotatedAt) })
          : ''}
        {connection.validation.failureCode
          ? t('appsInference.byok.card.checkFailed', { code: connection.validation.failureCode })
          : ''}
      </Text>
    </View>
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
    return <Skeleton.Box width="100%" height={60} borderRadius={10} />;
  }

  if (events.length === 0) {
    return <EmptyState variant="compact" title={t('appsInference.byok.trail.empty')} />;
  }

  return (
    <GroupedSection separator="line">
      {events.map((event) => (
        <GroupedSectionItem
          key={`${event.eventType}-${event.createdAt}`}
          title={event.eventType}
          titleNumberOfLines={0}
          description={`${event.environment} · ${providerConnectionAuditAttribution(event)} · ${formatDateTime(event.createdAt)}`}
        />
      ))}
    </GroupedSection>
  );
}
