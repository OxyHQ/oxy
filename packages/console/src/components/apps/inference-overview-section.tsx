import * as Skeleton from '@oxyhq/bloom/skeleton';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { useAccount } from '@/hooks/use-account';
import { useModelCatalogue } from '@/hooks/use-models';
import { useEffectiveRoutingPolicy } from '@/hooks/use-routing-policy';
import { useAccountProviderConnections } from '@/hooks/use-provider-connections';
import { connectionAppliesToApplication } from '@/lib/provider-connection';
import { effectivePolicyOrigin } from '@/lib/routing-policy';

/**
 * What is actually true about inference for this application, right now.
 *
 * Every line here reads a real API. Where an API does not exist yet the section
 * says so in one sentence rather than rendering an empty chart, because an empty
 * chart and "nothing is measured yet" look identical and only one of them is
 * true.
 *
 * The availability wording is `InferenceAvailabilityNotice`, reused rather than
 * restated — there is one statement about who may call the inference edge today,
 * and every page that shows a request against it uses those exact words.
 */
interface InferenceOverviewSectionProps {
  application: Application;
  access: CallerAccess;
}

export function InferenceOverviewSection({
  application,
  access,
}: InferenceOverviewSectionProps) {
  const { accounts } = useAccount();
  const ownerAccountId = application.ownerAccountId;
  const ownerAccount = accounts.find((account) => account.accountId === ownerAccountId);
  const canReadAccount =
    ownerAccount?.callerMembership?.permissions.includes('account:read') ?? false;

  const { data: catalogue = [], isLoading: isCatalogueLoading } = useModelCatalogue();
  const { data: policy, isLoading: isPolicyLoading } = useEffectiveRoutingPolicy(
    application._id,
    access.can('app:read')
  );
  const { data: connections = [] } = useAccountProviderConnections(
    ownerAccountId,
    canReadAccount
  );

  const applicableConnections = connections.filter((connection) =>
    connectionAppliesToApplication(connection, application._id, ownerAccountId)
  );
  const liveConnections = applicableConnections.filter(
    (connection) => connection.status === 'active' || connection.status === 'pending_validation'
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Inference</h2>
        <p className="text-sm text-muted-foreground">
          What this application can call, how its requests are routed, and whose provider account
          serves them.
        </p>
      </div>

      <InferenceAvailabilityNotice />

      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard
          label="Models available"
          isLoading={isCatalogueLoading}
          value={String(catalogue.length)}
          detail={
            catalogue.length === 0
              ? 'The catalogue is empty. No model is published for any caller yet.'
              : 'Published in the customer-facing catalogue.'
          }
        />
        <SummaryCard
          label="Routing policy"
          isLoading={isPolicyLoading}
          value={
            policy === null || policy === undefined
              ? 'None'
              : effectivePolicyOrigin(policy) === 'application'
                ? 'This application'
                : 'Inherited'
          }
          detail={
            policy === null || policy === undefined
              ? 'Requests are routed under Oxy’s defaults.'
              : `Version ${policy.policy.policyVersion}, optimising for ${policy.policy.optimiseFor}.`
          }
        />
        <SummaryCard
          label="Your provider credentials"
          isLoading={false}
          value={String(liveConnections.length)}
          detail={
            canReadAccount
              ? liveConnections.length === 0
                ? 'Requests would run on Oxy’s own provider accounts.'
                : 'Live connections that apply to this application.'
              : 'You do not have permission to see this account’s connections.'
          }
        />
      </div>

      <Alert>
        <AlertTitle>Usage and spend are not reported for inference yet</AlertTitle>
        <AlertDescription>
          Oxy records a receipt per request, but there is no endpoint serving those receipts to
          Console, so this page shows no per-request usage, no spend and no reservations. An empty
          chart would be indistinguishable from a chart of zero requests, so there is no chart.
        </AlertDescription>
      </Alert>

      {catalogue.length === 0 && (
        <div className="rounded-lg border border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Badge variant="outline">Catalogue</Badge>
            <p className="text-sm text-foreground">No model is published</p>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Routing policy controls that name a model, a provider, a region or a licence are
            offered from this catalogue, so most of them have nothing to select yet. The controls
            that do not depend on it — optimisation, data handling, fallback posture, price
            ceilings — are configurable today.
          </p>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  isLoading,
}: {
  label: string;
  value: string;
  detail: string;
  isLoading: boolean;
}) {
  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      {isLoading ? (
        <div className="mt-1">
          <Skeleton.Box width={80} height={28} />
        </div>
      ) : (
        <p className="mt-0.5 text-xl font-semibold text-foreground">{value}</p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}
