import { useState } from 'react';
import { Text, View } from 'react-native';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiArrowUpDownLine } from '@oxy.so/bloom/icons/RiArrowUpDownLine';
import { RiRouteLine } from '@oxy.so/bloom/icons/RiRouteLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import type { Application, CallerAccess } from '@/hooks/use-applications';
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

const formatDateTime = (iso: string): string => new Date(iso).toLocaleString();

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
    return <EmptyState variant="compact" title={t('appsInference.routing.noPermission')} />;
  }

  if (isLoading) {
    return <Skeleton.Box width="100%" height={220} borderRadius={14} />;
  }

  if (isError) {
    return (
      <Admonition type="error">
        <Text className="font-semibold">{t('appsInference.routing.loadFailedTitle')}</Text>
        {`\n${getErrorMessage(error, t('appsInference.routing.loadFailedFallback'))}`}
      </Admonition>
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
      <Card appearance="outline" radius="radius-16">
        <CardHeader>
          <CardTitle>{t('appsInference.routing.title')}</CardTitle>
          <CardDescription>{t('appsInference.routing.description')}</CardDescription>
        </CardHeader>
        {canWrite && (
          <CardFooter>
            {isOwnPolicy ? (
              <>
                <Button appearance="plain" size="sm" onPress={() => setConfirmArchive(true)}>
                  {t('appsInference.routing.archive')}
                </Button>
                <Button appearance="outline" size="sm" onPress={() => setMode('edit')}>
                  {t('common.edit')}
                </Button>
              </>
            ) : (
              <Button size="sm" onPress={() => setMode('create')}>
                {stored
                  ? t('appsInference.routing.override')
                  : t('appsInference.routing.createPolicy')}
              </Button>
            )}
          </CardFooter>
        )}
      </Card>

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
            <Admonition type="info">
              <Text className="font-semibold">{t('appsInference.routing.inherited.title')}</Text>
              {`\n${t('appsInference.routing.inherited.body')}`}
            </Admonition>
          )}

          <GroupedSection
            title={`${t('appsInference.routing.version', { version: stored.policy.policyVersion })} · ${
              isOwnPolicy
                ? t('appsInference.routing.scopeApplication')
                : t('appsInference.routing.scopeAccount')
            }`}
            footer={t('appsInference.routing.updated', {
              date: formatDateTime(stored.policy.updatedAt),
            })}
            separator="line"
          >
            <GroupedSectionItem
              title={t('appsInference.routing.statusLabel')}
              rightElement={
                <Badge
                  content={stored.status}
                  variant="subtle"
                  color={stored.status === 'active' ? 'success' : 'default'}
                  size="label-small"
                />
              }
            />
            {routingPolicyHighlights(stored.policy, routingProfiles).map((highlight) => (
              <GroupedSectionItem
                key={highlight.label}
                title={highlight.label}
                value={highlight.value}
                titleNumberOfLines={0}
              />
            ))}
          </GroupedSection>

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
      <GroupedSection
        title={t('appsInference.routing.history.title')}
        footer={t('appsInference.routing.history.description')}
        separator="line"
      >
        {shown.map((version) => (
          <GroupedSectionItem
            key={version.versionId}
            title={t('appsInference.routing.version', { version: version.policy.policyVersion })}
            description={t('appsInference.routing.history.optimiseFor', {
              value: version.policy.optimiseFor,
            })}
            value={formatDateTime(version.policy.updatedAt)}
          />
        ))}
      </GroupedSection>
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

  return isLoading ? (
    <Skeleton.Box width="100%" height={80} borderRadius={14} />
  ) : events.length === 0 ? (
    <EmptyState
      icon={RiArrowUpDownLine}
      variant="compact"
      title={t('appsInference.routing.switches.title')}
      description={t('appsInference.routing.switches.empty')}
    />
  ) : (
    <GroupedSection
      title={t('appsInference.routing.switches.title')}
      footer={t('appsInference.routing.switches.description')}
      separator="line"
    >
      {events.map((event) => (
        <GroupedSectionItem
          key={event.eventId}
          title={event.reason.replaceAll('_', ' ')}
          description={`${event.fromModelReference} → ${event.toModelReference} · ${event.toProvider} · ${formatDateTime(event.occurredAt)}`}
          titleNumberOfLines={0}
          rightElement={
            <Badge
              content={
                event.scope === 'model'
                  ? t('appsInference.routing.switches.differentModel')
                  : t('appsInference.routing.switches.sameModel')
              }
              variant={event.scope === 'model' ? 'subtle' : 'outlined'}
              color={event.scope === 'model' ? 'primary' : 'default'}
              size="label-small"
            />
          }
        />
      ))}
    </GroupedSection>
  );
}
