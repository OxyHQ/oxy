import { useState } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { toast } from '@oxyhq/bloom/toast';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDataTransferHorizontalIcon, Route01Icon } from '@hugeicons/core-free-icons';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import type { RouteSwitchEvent } from '@/hooks/use-routing-policy';
import type { RoutingPolicyControls, StoredRoutingPolicy } from '@/lib/routing-policy';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { RoutingPolicyForm } from '@/components/apps/routing-policy-form';
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
import {
  controlsFromPolicy,
  defaultRoutingPolicyControls,
  effectivePolicyOrigin,
  routingPolicyHighlights,
} from '@/lib/routing-policy';

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
 * Those are the strings the routes themselves gate on.
 */
interface RoutingPolicySectionProps {
  application: Application;
  access: CallerAccess;
}

export function RoutingPolicySection({ application, access }: RoutingPolicySectionProps) {
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
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        You do not have permission to view this application's routing policy.
      </div>
    );
  }

  if (isLoading) {
    return <Skeleton.Box width="100%" height={220} borderRadius={14} />;
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Routing policy could not be loaded</AlertTitle>
        <AlertDescription>
          {getErrorMessage(error, 'The routing policy control plane did not answer.')}
        </AlertDescription>
      </Alert>
    );
  }

  const origin = stored ? effectivePolicyOrigin(stored) : null;
  const isOwnPolicy = origin === 'application';

  const handleCreate = async (controls: RoutingPolicyControls) => {
    try {
      await createPolicy.mutateAsync({ applicationId: appId, controls });
      setMode('view');
      toast.success('Routing policy created');
    } catch (createError) {
      toast.error(getErrorMessage(createError, 'Failed to create the routing policy'));
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
      toast.success('New policy version saved');
    } catch (editError) {
      toast.error(getErrorMessage(editError, 'Failed to save the new policy version'));
    }
  };

  const handleArchive = async () => {
    if (!stored) {
      return;
    }
    try {
      await archivePolicy.mutateAsync({
        policyId: stored.routingPolicyId,
        applicationId: appId,
      });
      setConfirmArchive(false);
      toast.success('Routing policy archived');
    } catch (archiveError) {
      toast.error(getErrorMessage(archiveError, 'Failed to archive the routing policy'));
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
        submitLabel="Create policy"
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
        submitLabel="Save new version"
        isPending={appendVersion.isPending}
        catalogue={catalogue}
        routingProfiles={routingProfiles}
        onSubmit={handleEdit}
        onCancel={() => setMode('view')}
      />
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Routing policy</h2>
          <p className="text-sm text-muted-foreground">
            Which providers, regions, licences and prices this application will accept. Oxy's data
            plane executes it; a request records the exact version it ran under.
          </p>
        </div>
        {canWrite && (
          <div className="flex shrink-0 items-center gap-2">
            {isOwnPolicy && (
              <>
                <Button size="sm" variant="outline" onClick={() => setMode('edit')}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmArchive(true)}>
                  Archive
                </Button>
              </>
            )}
            {!isOwnPolicy && (
              <Button size="sm" onClick={() => setMode('create')}>
                {stored ? 'Override for this application' : 'Create policy'}
              </Button>
            )}
          </div>
        )}
      </div>

      {stored === null || stored === undefined ? (
        <div className="rounded-lg border border-border py-10 text-center">
          <HugeiconsIcon
            icon={Route01Icon}
            size={40}
            className="text-muted-foreground mx-auto mb-3"
          />
          <p className="text-sm font-medium text-foreground">No routing policy</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Neither this application nor its account has one. Requests are routed under Oxy's
            defaults until you set one.
          </p>
        </div>
      ) : (
        <>
          {!isOwnPolicy && (
            <Alert>
              <AlertTitle>Inherited from the account</AlertTitle>
              <AlertDescription>
                This is the account-wide floor, shared with every other application in the account.
                Creating a policy here overrides it for this application only.
              </AlertDescription>
            </Alert>
          )}

          <div className="rounded-lg border border-border">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <Badge variant={stored.status === 'active' ? 'default' : 'secondary'}>
                {stored.status}
              </Badge>
              <Badge variant="outline">Version {stored.policy.policyVersion}</Badge>
              <Badge variant="ghost">{isOwnPolicy ? 'Application scope' : 'Account scope'}</Badge>
              <span className="text-xs text-muted-foreground">
                Updated {new Date(stored.policy.updatedAt).toLocaleString()}
              </span>
            </div>
            <dl className="divide-y divide-border">
              {routingPolicyHighlights(stored.policy).map((highlight) => (
                <div
                  key={highlight.label}
                  className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5"
                >
                  <dt className="text-sm text-muted-foreground">{highlight.label}</dt>
                  <dd className="text-sm text-foreground">{highlight.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <PolicyVersionHistory policyId={stored.routingPolicyId} />
        </>
      )}

      <RouteSwitchHistory applicationId={appId} enabled={access.can('usage:read')} />

      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this routing policy</AlertDialogTitle>
            <AlertDialogDescription>
              The application falls back to its account's policy, or to Oxy's defaults if there is
              none. Every past version stays readable, so a charge already settled under this policy
              can still be explained against it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleArchive} disabled={archivePolicy.isPending}>
              {archivePolicy.isPending ? 'Archiving…' : 'Archive'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
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
    <section className="space-y-3">
      <div>
        <p className="text-sm font-semibold text-foreground">Version history</p>
        <p className="text-sm text-muted-foreground">
          Editing appends a version and leaves the previous one untouched. Nothing here is edited
          in place and nothing is deleted.
        </p>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border">
        {shown.map((version) => (
          <div
            key={version.versionId}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
          >
            <div className="flex items-center gap-2">
              <Badge variant="outline">Version {version.policy.policyVersion}</Badge>
              <span className="text-sm text-muted-foreground">
                optimise for {version.policy.optimiseFor}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {new Date(version.policy.updatedAt).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
      {versions.length > 5 && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded((current) => !current)}>
          {expanded ? 'Show fewer versions' : `Show all ${versions.length} versions`}
        </Button>
      )}
    </section>
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
  const { data: events = [], isLoading } = useRouteSwitchEvents(applicationId, 50, enabled);

  if (!enabled) {
    return null;
  }

  return (
    <section className="space-y-3">
      <div>
        <p className="text-sm font-semibold text-foreground">Route switches</p>
        <p className="text-sm text-muted-foreground">
          When a request was served somewhere other than its first route. A cross-model switch
          appears only where your own policy authorised that destination by name.
        </p>
      </div>
      {isLoading ? (
        <Skeleton.Box width="100%" height={80} borderRadius={14} />
      ) : events.length === 0 ? (
        <div className="rounded-lg border border-border py-8 text-center">
          <HugeiconsIcon
            icon={ArrowDataTransferHorizontalIcon}
            size={32}
            className="text-muted-foreground mx-auto mb-2"
          />
          <p className="text-sm text-muted-foreground">No route switch has been recorded.</p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {events.map((event) => (
            <RouteSwitchRow key={event.eventId} event={event} />
          ))}
        </div>
      )}
    </section>
  );
}

function RouteSwitchRow({ event }: { event: RouteSwitchEvent }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={event.scope === 'model' ? 'default' : 'outline'}>
            {event.scope === 'model' ? 'Different model' : 'Same model, other deployment'}
          </Badge>
          <span className="text-sm text-foreground">{event.reason.replaceAll('_', ' ')}</span>
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {event.fromModelReference} → {event.toModelReference} · {event.toProvider}
        </p>
      </div>
      <span className="text-xs text-muted-foreground">
        {new Date(event.occurredAt).toLocaleString()}
      </span>
    </div>
  );
}
