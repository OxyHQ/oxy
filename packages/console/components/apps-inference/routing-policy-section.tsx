import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiArrowUpDownLine } from '@oxy.so/bloom/icons/RiArrowUpDownLine';
import { RiRouteLine } from '@oxy.so/bloom/icons/RiRouteLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import type { RouteSwitchEvent } from '@/hooks/use-routing-policy';
import type { RoutingPolicyControls, StoredRoutingPolicy } from '@/lib/routing-policy';
import { useModelCatalogue, useRoutingProfiles } from '@/hooks/use-models';
import {
  useAppendRoutingPolicyVersion,
  useArchiveRoutingPolicy,
  useCreateApplicationRoutingPolicy,
  useEffectiveRoutingPolicy,
  useRouteSwitchEvents,
  useRoutingPolicyVersions,
} from '@/hooks/use-routing-policy';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import {
  controlsFromPolicy,
  defaultRoutingPolicyControls,
  effectivePolicyOrigin,
  routingPolicyHighlights,
} from '@/lib/routing-policy';
import { RoutingPolicyForm } from './routing-policy-form';
import {
  formatDateTime,
  MutedText,
  NoPermission,
  Notice,
  Panel,
  PanelRow,
  Pill,
  SectionHeader,
} from './ui';

/**
 * The routing policy in force for one application, and the controls to change it.
 *
 * The distinction the section is built around is the one a customer debugging a
 * route actually asks: is this MY application's policy, or the floor it inherits
 * from the account? An inherited policy is shown read-only with the offer to
 * create an application policy that overrides it — editing it here would edit
 * every sibling application at once, silently.
 *
 * Permissions come from the server on every affordance: `app:read` to see the
 * policy, `app:update` to write one, `usage:read` for the route-switch record.
 */
export function RoutingPolicySection({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const appId = application._id;
  const canRead = access.can('app:read');
  const canWrite = access.can('app:update');

  const { data: stored, isLoading, isError, error } = useEffectiveRoutingPolicy(appId, canRead);
  const { data: catalogue = [] } = useModelCatalogue();
  const { data: routingProfiles = [] } = useRoutingProfiles();

  const createPolicy = useCreateApplicationRoutingPolicy();
  const appendVersion = useAppendRoutingPolicyVersion();
  const archivePolicy = useArchiveRoutingPolicy();

  const [mode, setMode] = useState<'view' | 'create' | 'edit'>('view');
  const [confirmArchive, setConfirmArchive] = useState(false);

  if (!canRead) {
    return <NoPermission>{t('appsInference.routing.noPermission')}</NoPermission>;
  }

  if (isLoading) {
    return <Skeleton.Box width="100%" height={220} borderRadius={14} />;
  }

  if (isError) {
    return (
      <Notice type="error" title={t('appsInference.routing.loadFailedTitle')}>
        {getErrorMessage(error, t('appsInference.routing.loadFailedFallback'))}
      </Notice>
    );
  }

  const origin = stored ? effectivePolicyOrigin(stored) : null;
  const isOwnPolicy = origin === 'application';

  const handleCreate = async (controls: RoutingPolicyControls) => {
    try {
      await createPolicy.mutateAsync({ applicationId: appId, controls });
      setMode('view');
      toast.success(t('appsInference.routing.created'));
    } catch (createError) {
      toast.error(getErrorMessage(createError, t('appsInference.routing.createFailed')));
    }
  };

  const handleEdit = async (controls: RoutingPolicyControls) => {
    if (!stored) {
      return;
    }
    try {
      await appendVersion.mutateAsync({
        policyId: stored.routingPolicyId,
        applicationId: appId,
        controls,
      });
      setMode('view');
      toast.success(t('appsInference.routing.versionSaved'));
    } catch (editError) {
      toast.error(getErrorMessage(editError, t('appsInference.routing.versionFailed')));
    }
  };

  const handleArchive = async () => {
    if (!stored) {
      return;
    }
    try {
      await archivePolicy.mutateAsync({ policyId: stored.routingPolicyId, applicationId: appId });
      setConfirmArchive(false);
      toast.success(t('appsInference.routing.archived'));
    } catch (archiveError) {
      toast.error(getErrorMessage(archiveError, t('appsInference.routing.archiveFailed')));
    }
  };

  if (mode === 'create') {
    return (
      <RoutingPolicyForm
        initial={
          // Starting an application policy from the account floor it is about to
          // override is the honest default: the customer is narrowing a policy
          // they already have, not writing an unrelated one from nothing.
          stored ? controlsFromPolicy(stored.policy) : defaultRoutingPolicyControls()
        }
        submitLabel={t('appsInference.routing.createPolicy')}
        isPending={createPolicy.isPending}
        catalogue={catalogue}
        routingProfiles={routingProfiles}
        onSubmit={handleCreate}
        onCancel={() => setMode('view')}
      />
    );
  }

  if (mode === 'edit' && stored) {
    return (
      <RoutingPolicyForm
        initial={controlsFromPolicy(stored.policy)}
        submitLabel={t('appsInference.routing.saveVersion')}
        isPending={appendVersion.isPending}
        catalogue={catalogue}
        routingProfiles={routingProfiles}
        onSubmit={handleEdit}
        onCancel={() => setMode('view')}
      />
    );
  }

  return (
    <View className="gap-8">
      <SectionHeader
        title={t('appsInference.routing.title')}
        description={t('appsInference.routing.description')}
        action={
          canWrite ? (
            isOwnPolicy ? (
              <>
                <Button appearance="outline" size="sm" onPress={() => setMode('edit')}>
                  {t('common.edit')}
                </Button>
                <Button appearance="plain" size="sm" onPress={() => setConfirmArchive(true)}>
                  {t('appsInference.routing.archive')}
                </Button>
              </>
            ) : (
              <Button size="sm" onPress={() => setMode('create')}>
                {stored
                  ? t('appsInference.routing.override')
                  : t('appsInference.routing.createPolicy')}
              </Button>
            )
          ) : undefined
        }
      />

      {stored === null || stored === undefined ? (
        <EmptyState
          icon={RiRouteLine}
          variant="compact"
          title={t('appsInference.routing.none.title')}
          description={t('appsInference.routing.none.body')}
        />
      ) : (
        <>
          {!isOwnPolicy && (
            <Notice title={t('appsInference.routing.inherited.title')}>
              {t('appsInference.routing.inherited.body')}
            </Notice>
          )}

          <Panel>
            <View className="flex-row flex-wrap items-center gap-2 px-4 py-3">
              <Pill
                label={stored.status}
                tone={stored.status === 'active' ? 'default' : 'secondary'}
              />
              <Pill
                label={t('appsInference.routing.version', { version: stored.policy.policyVersion })}
                tone="outline"
              />
              <Pill
                label={
                  isOwnPolicy
                    ? t('appsInference.routing.scopeApplication')
                    : t('appsInference.routing.scopeAccount')
                }
                tone="ghost"
              />
              <MutedText small>
                {t('appsInference.routing.updated', {
                  date: formatDateTime(stored.policy.updatedAt),
                })}
              </MutedText>
            </View>
            {routingPolicyHighlights(stored.policy, routingProfiles).map((highlight) => (
              <PanelRow key={highlight.label}>
                <View className="flex-row flex-wrap items-baseline justify-between gap-2">
                  <Text className="text-sm text-muted-foreground">{highlight.label}</Text>
                  <Text className="text-sm text-foreground">{highlight.value}</Text>
                </View>
              </PanelRow>
            ))}
          </Panel>

          <PolicyVersionHistory policyId={stored.routingPolicyId} />
        </>
      )}

      <RouteSwitchHistory applicationId={appId} enabled={access.can('usage:read')} />

      <Dialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        title={t('appsInference.routing.archiveDialog.title')}
        description={t('appsInference.routing.archiveDialog.body')}
        actions={[
          {
            label: archivePolicy.isPending
              ? t('appsInference.routing.archiveDialog.archiving')
              : t('appsInference.routing.archive'),
            color: 'destructive',
            loading: archivePolicy.isPending,
            shouldCloseOnPress: false,
            onPress: handleArchive,
          },
          { label: t('common.cancel'), color: 'cancel' },
        ]}
      />
    </View>
  );
}

/**
 * Every version of the policy, newest first.
 *
 * This is what a receipt's `{routingPolicyId, policyVersion}` resolves through:
 * editing appends, so a settled charge can always be read against the
 * configuration that produced it rather than against the configuration that
 * exists now.
 */
function PolicyVersionHistory({ policyId }: { policyId: string }) {
  const { t } = useTranslation();
  const { data: versions = [], isLoading } = useRoutingPolicyVersions(policyId);
  const [expanded, setExpanded] = useState(false);

  if (isLoading) {
    return <Skeleton.Box width="100%" height={80} borderRadius={14} />;
  }

  if (versions.length === 0) {
    return null;
  }

  const shown: Array<StoredRoutingPolicy> = expanded ? versions : versions.slice(0, 5);

  return (
    <View className="gap-3">
      <SectionHeader
        title={t('appsInference.routing.history.title')}
        description={t('appsInference.routing.history.description')}
      />
      <Panel>
        {shown.map((version, index) => (
          <PanelRow key={version.versionId} first={index === 0}>
            <View className="flex-row flex-wrap items-center justify-between gap-2">
              <View className="flex-row items-center gap-2">
                <Pill
                  label={t('appsInference.routing.version', {
                    version: version.policy.policyVersion,
                  })}
                  tone="outline"
                />
                <MutedText>
                  {t('appsInference.routing.history.optimiseFor', {
                    value: version.policy.optimiseFor,
                  })}
                </MutedText>
              </View>
              <MutedText small>{formatDateTime(version.policy.updatedAt)}</MutedText>
            </View>
          </PanelRow>
        ))}
      </Panel>
      {versions.length > 5 && (
        <View className="flex-row">
          <Button appearance="plain" size="sm" onPress={() => setExpanded((current) => !current)}>
            {expanded
              ? t('appsInference.routing.history.showFewer')
              : t('appsInference.routing.history.showAll', { count: versions.length })}
          </Button>
        </View>
      )}
    </View>
  );
}

/**
 * The customer-visible record of every allowed route switch.
 *
 * A `model`-scoped entry exists only where this policy authorised that
 * destination BY NAME — the row cannot be written otherwise — so the list is a
 * record of substitutions the customer permitted, never a log of surprises.
 */
function RouteSwitchHistory({
  applicationId,
  enabled,
}: {
  applicationId: string;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const { data: events = [], isLoading } = useRouteSwitchEvents(applicationId, 50, enabled);

  if (!enabled) {
    return null;
  }

  return (
    <View className="gap-3">
      <SectionHeader
        title={t('appsInference.routing.switches.title')}
        description={t('appsInference.routing.switches.description')}
      />
      {isLoading ? (
        <Skeleton.Box width="100%" height={80} borderRadius={14} />
      ) : events.length === 0 ? (
        <EmptyState
          icon={RiArrowUpDownLine}
          variant="compact"
          title={t('appsInference.routing.switches.empty')}
        />
      ) : (
        <Panel>
          {events.map((event, index) => (
            <RouteSwitchRow key={event.eventId} event={event} first={index === 0} />
          ))}
        </Panel>
      )}
    </View>
  );
}

function RouteSwitchRow({ event, first }: { event: RouteSwitchEvent; first: boolean }) {
  const { t } = useTranslation();
  return (
    <PanelRow first={first}>
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <View className="min-w-0">
          <View className="flex-row flex-wrap items-center gap-2">
            <Pill
              label={
                event.scope === 'model'
                  ? t('appsInference.routing.switches.differentModel')
                  : t('appsInference.routing.switches.sameModel')
              }
              tone={event.scope === 'model' ? 'default' : 'outline'}
            />
            <Text className="text-sm text-foreground">{event.reason.replaceAll('_', ' ')}</Text>
          </View>
          <Text className="mt-1 font-mono text-xs text-muted-foreground">
            {`${event.fromModelReference} → ${event.toModelReference} · ${event.toProvider}`}
          </Text>
        </View>
        <MutedText small>{formatDateTime(event.occurredAt)}</MutedText>
      </View>
    </PanelRow>
  );
}
