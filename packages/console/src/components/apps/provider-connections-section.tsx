import { useState } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { toast } from '@oxyhq/bloom/toast';
import { HugeiconsIcon } from '@hugeicons/react';
import { CloudIcon } from '@hugeicons/core-free-icons';
import type { InferenceEnvironment } from '@oxyhq/contracts';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import type { ProviderConnectionView } from '@/lib/provider-connection';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { useAccount } from '@/hooks/use-account';
import {
  useAccountProviderConnections,
  useCreateApplicationProviderConnection,
  useProviderConnectionAudit,
  useRevokeProviderConnection,
  useRotateProviderConnection,
  useSetProviderConnectionEnabled,
} from '@/hooks/use-provider-connections';
import { getErrorMessage } from '@/lib/api-error';
import {
  connectionAppliesToApplication,
  connectionStatusVariant,
  isSecretStoreUnavailable,
  providerConnectionScopeLabel,
  shortFingerprint,
} from '@/lib/provider-connection';

/**
 * BYOK — the customer's own upstream provider credentials, as they apply to one
 * application.
 *
 * Three things this section is careful about:
 *
 *  - **It never shows a secret, and never shows the secret's ADDRESS.** The API
 *    returns a `secretRef` (`vault:…` / `kms:…`); `toProviderConnectionView`
 *    drops it in the query's `select`, so it is gone before any component sees
 *    it. What is rendered is the safe prefix and the fingerprint, which are the
 *    two fields the contract exists to make showable.
 *  - **"No secret store in this deployment" is a state, not an error.** The API
 *    answers `503 provider_secret_store_unavailable` and refuses BEFORE reading
 *    the credential out of the request, so an unconfigured deployment never
 *    holds a customer secret at all. Console renders that as a standing
 *    explanation with no retry, because retrying changes nothing — what changes
 *    it is an operator wiring a store.
 *  - **Disable and revoke keep working when create and rotate do not.** Those
 *    two are pure database work on the server, which is the point: taking a
 *    credential out of service must not depend on the availability of the thing
 *    you are trying to stop using.
 *
 * Every affordance is gated on a server-supplied permission: `app:update` for a
 * connection scoped to this application, `account:update` for one inherited from
 * the account, both read off `callerMembership.permissions`.
 */
interface ProviderConnectionsSectionProps {
  application: Application;
  access: CallerAccess;
}

const ENVIRONMENTS: Array<{ value: InferenceEnvironment; label: string }> = [
  { value: 'development', label: 'Development' },
  { value: 'staging', label: 'Staging' },
  { value: 'production', label: 'Production' },
];

export function ProviderConnectionsSection({
  application,
  access,
}: ProviderConnectionsSectionProps) {
  const { accounts } = useAccount();
  const ownerAccountId = application.ownerAccountId;
  const ownerAccount = accounts.find((account) => account.accountId === ownerAccountId);
  const ownerPermissions = ownerAccount?.callerMembership?.permissions ?? [];
  const canReadAccount = ownerPermissions.includes('account:read');
  const canUpdateAccount = ownerPermissions.includes('account:update');
  const canUpdateApplication = access.can('app:update');

  const {
    data: connections = [],
    isLoading,
    isError,
    error,
  } = useAccountProviderConnections(ownerAccountId, canReadAccount);

  const createConnection = useCreateApplicationProviderConnection();
  const rotateConnection = useRotateProviderConnection();
  const setEnabled = useSetProviderConnectionEnabled();
  const revokeConnection = useRevokeProviderConnection();

  /**
   * The API's own sentence explaining why this deployment cannot hold a
   * credential, once a write has actually established it.
   *
   * Deliberately not assumed up front: Console has no read-only way to ask
   * whether a secret store is wired, and claiming "unavailable" without having
   * been told so would be a guess that reads exactly like a fact.
   */
  const [storeUnavailable, setStoreUnavailable] = useState<string | null>(null);

  const [showConnect, setShowConnect] = useState(false);
  const [provider, setProvider] = useState('');
  const [environment, setEnvironment] = useState<InferenceEnvironment>('development');
  const [acknowledgeTerms, setAcknowledgeTerms] = useState(false);
  const [secret, setSecret] = useState('');

  const [rotating, setRotating] = useState<ProviderConnectionView | null>(null);
  const [rotationSecret, setRotationSecret] = useState('');
  const [revoking, setRevoking] = useState<ProviderConnectionView | null>(null);
  const [trailFor, setTrailFor] = useState<string | null>(null);

  const applicable = connections.filter((connection) =>
    connectionAppliesToApplication(connection, application._id, ownerAccountId)
  );

  /** Which permission governs this connection is decided by ITS scope, as on the server. */
  const canManage = (connection: ProviderConnectionView): boolean =>
    connection.scope.kind === 'application' ? canUpdateApplication : canUpdateAccount;

  const closeConnectDialog = () => {
    setShowConnect(false);
    setProvider('');
    setEnvironment('development');
    setAcknowledgeTerms(false);
    // The credential leaves component state the moment the dialog closes,
    // whatever the outcome.
    setSecret('');
  };

  const handleConnect = async () => {
    try {
      await createConnection.mutateAsync({
        applicationId: application._id,
        ownerAccountId,
        provider: provider.trim(),
        environment,
        secret,
        acknowledgeProviderTerms: acknowledgeTerms,
      });
      closeConnectDialog();
      toast.success('Provider connection created');
    } catch (connectError) {
      setSecret('');
      if (isSecretStoreUnavailable(connectError)) {
        setStoreUnavailable(
          getErrorMessage(connectError, 'This deployment has no managed secret store configured.')
        );
        setShowConnect(false);
        return;
      }
      toast.error(getErrorMessage(connectError, 'Failed to create the provider connection'));
    }
  };

  const handleRotate = async () => {
    if (!rotating) {
      return;
    }
    try {
      await rotateConnection.mutateAsync({
        connectionId: rotating.connectionId,
        ownerAccountId,
        secret: rotationSecret,
      });
      setRotating(null);
      setRotationSecret('');
      toast.success('Credential rotated');
    } catch (rotateError) {
      setRotationSecret('');
      if (isSecretStoreUnavailable(rotateError)) {
        setStoreUnavailable(
          getErrorMessage(rotateError, 'This deployment has no managed secret store configured.')
        );
        setRotating(null);
        return;
      }
      toast.error(getErrorMessage(rotateError, 'Failed to rotate the credential'));
    }
  };

  const handleSetEnabled = async (connection: ProviderConnectionView, enabled: boolean) => {
    try {
      await setEnabled.mutateAsync({
        connectionId: connection.connectionId,
        ownerAccountId,
        enabled,
      });
      toast.success(enabled ? 'Connection enabled' : 'Connection disabled');
    } catch (toggleError) {
      toast.error(
        getErrorMessage(toggleError, enabled ? 'Failed to enable' : 'Failed to disable')
      );
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
      toast.success('Connection revoked');
    } catch (revokeError) {
      toast.error(getErrorMessage(revokeError, 'Failed to revoke the connection'));
    }
  };

  if (!canReadAccount) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        You do not have permission to view this application's provider connections.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Provider connections</h2>
          <p className="text-sm text-muted-foreground">
            Your own upstream provider credentials. The provider bills your account directly and Oxy
            charges only its platform fee. Oxy stores a reference to your credential in managed
            secret storage — never the credential, and never in a page like this one.
          </p>
        </div>
        {canUpdateApplication && storeUnavailable === null && (
          <Button size="sm" className="shrink-0" onClick={() => setShowConnect(true)}>
            Connect a provider
          </Button>
        )}
      </div>

      {storeUnavailable !== null && (
        <Alert>
          <AlertTitle>Bring your own key is not available in this deployment</AlertTitle>
          <AlertDescription>
            <span className="block">{storeUnavailable}</span>
            <span className="mt-2 block">
              Nothing went wrong and there is nothing to retry — Oxy refused before reading your
              credential, so it never held it. Existing connections can still be disabled and
              revoked.
            </span>
          </AlertDescription>
        </Alert>
      )}

      <Alert>
        <AlertTitle>What connecting a provider does and does not do</AlertTitle>
        <AlertDescription>
          Using your own credential does not change the provider's terms and does not permit sharing
          a credential with anyone. Whether your credentials may or must be used for routing is a
          routing-policy setting, not a property of the connection.
        </AlertDescription>
      </Alert>

      {isError ? (
        <Alert variant="destructive">
          <AlertTitle>Provider connections could not be loaded</AlertTitle>
          <AlertDescription>
            {getErrorMessage(error, 'The provider connection control plane did not answer.')}
          </AlertDescription>
        </Alert>
      ) : isLoading ? (
        <Skeleton.Box width="100%" height={120} borderRadius={14} />
      ) : applicable.length === 0 ? (
        <div className="rounded-lg border border-border py-10 text-center">
          <HugeiconsIcon icon={CloudIcon} size={40} className="text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium text-foreground">No provider connection</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            This application uses Oxy's own provider accounts. Connect one of yours to have requests
            served on it instead.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {applicable.map((connection) => (
            <ConnectionCard
              key={connection.connectionId}
              connection={connection}
              canManage={canManage(connection)}
              storeUnavailable={storeUnavailable !== null}
              isTrailOpen={trailFor === connection.connectionId}
              onToggleTrail={() =>
                setTrailFor((current) =>
                  current === connection.connectionId ? null : connection.connectionId
                )
              }
              onRotate={() => {
                setRotationSecret('');
                setRotating(connection);
              }}
              onSetEnabled={(enabled) => handleSetEnabled(connection, enabled)}
              onRevoke={() => setRevoking(connection)}
            />
          ))}
        </div>
      )}

      {/* Connect */}
      <Dialog
        open={showConnect}
        onOpenChange={(open) => (open ? setShowConnect(true) : closeConnectDialog())}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect a provider</DialogTitle>
            <DialogDescription>
              The credential is sent once, written to managed secret storage, and never returned. Oxy
              keeps a reference, a short prefix and a fingerprint.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="byok-provider" className="text-sm">
                Provider
              </Label>
              <Input
                id="byok-provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value.toLowerCase())}
                placeholder="provider-slug"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                The provider's slug in Oxy's catalogue. Oxy refuses a provider it does not serve.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="byok-environment" className="text-sm">
                Environment
              </Label>
              <Select
                value={environment}
                onValueChange={(value) => setEnvironment(value as InferenceEnvironment)}
              >
                <SelectTrigger id="byok-environment" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENVIRONMENTS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-foreground">
                  I accept this provider's terms
                </p>
                <p className="text-xs text-muted-foreground">
                  Some providers require each customer to accept their terms before a third party
                  may present their credential.
                </p>
              </div>
              <Switch checked={acknowledgeTerms} onCheckedChange={setAcknowledgeTerms} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="byok-secret" className="text-sm">
                Credential
              </Label>
              <Input
                id="byok-secret"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeConnectDialog}>
              Cancel
            </Button>
            <Button
              onClick={handleConnect}
              disabled={
                createConnection.isPending || provider.trim() === '' || secret.length === 0
              }
            >
              {createConnection.isPending ? 'Connecting…' : 'Connect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate */}
      <Dialog
        open={rotating !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRotating(null);
            setRotationSecret('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate this credential</DialogTitle>
            <DialogDescription>
              The connection keeps its reference, so anything holding it keeps working. The previous
              credential is gone the moment the new one lands, and a rotation must supply a
              different credential.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="byok-rotation-secret" className="text-sm">
              New credential
            </Label>
            <Input
              id="byok-rotation-secret"
              type="password"
              value={rotationSecret}
              onChange={(event) => setRotationSecret(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRotating(null);
                setRotationSecret('');
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRotate}
              disabled={rotateConnection.isPending || rotationSecret.length === 0}
            >
              {rotateConnection.isPending ? 'Rotating…' : 'Rotate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke */}
      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this connection</AlertDialogTitle>
            <AlertDialogDescription>
              Revoking is permanent and destroys the stored credential. The connection itself stays
              readable, along with its trail, so a charge already served on it can still be
              explained. Requests stop using it immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRevoke}
              disabled={revokeConnection.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revokeConnection.isPending ? 'Revoking…' : 'Revoke'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ConnectionCard({
  connection,
  canManage,
  storeUnavailable,
  isTrailOpen,
  onToggleTrail,
  onRotate,
  onSetEnabled,
  onRevoke,
}: {
  connection: ProviderConnectionView;
  canManage: boolean;
  storeUnavailable: boolean;
  isTrailOpen: boolean;
  onToggleTrail: () => void;
  onRotate: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onRevoke: () => void;
}) {
  const isRevoked = connection.status === 'revoked';

  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">{connection.provider}</p>
            <Badge variant={connectionStatusVariant(connection.status)}>{connection.status}</Badge>
            <Badge variant="outline">{connection.environment}</Badge>
            <Badge variant="ghost">{connection.validation.state}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {providerConnectionScopeLabel(connection.scope)}
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            {connection.keyPrefix}… · fingerprint {shortFingerprint(connection.fingerprint)}
          </p>
          <p className="text-xs text-muted-foreground">
            Connected {new Date(connection.createdAt).toLocaleDateString()}
            {connection.rotatedAt
              ? ` · rotated ${new Date(connection.rotatedAt).toLocaleDateString()}`
              : ''}
            {connection.validation.failureCode
              ? ` · last check failed: ${connection.validation.failureCode}`
              : ''}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onToggleTrail}>
            {isTrailOpen ? 'Hide trail' : 'Trail'}
          </Button>
          {canManage && !isRevoked && (
            <>
              {/* Rotation writes a credential, so it is unavailable for the same
                  reason connecting one is. Disable and revoke are not. */}
              {!storeUnavailable && (
                <Button variant="ghost" size="sm" onClick={onRotate}>
                  Rotate
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSetEnabled(connection.status === 'disabled')}
              >
                {connection.status === 'disabled' ? 'Enable' : 'Disable'}
              </Button>
              <Button variant="ghost" size="sm" className="text-destructive" onClick={onRevoke}>
                Revoke
              </Button>
            </>
          )}
        </div>
      </div>

      {isTrailOpen && <ConnectionTrail connectionId={connection.connectionId} />}
    </div>
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
  const { data: events = [], isLoading } = useProviderConnectionAudit(connectionId);

  if (isLoading) {
    return (
      <div className="border-t border-border px-4 py-3">
        <Skeleton.Box width="100%" height={60} borderRadius={10} />
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
        No recorded activity.
      </p>
    );
  }

  return (
    <div className="divide-y divide-border border-t border-border">
      {events.map((event) => (
        <div
          key={`${event.eventType}-${event.createdAt}`}
          className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
        >
          <div className="flex items-center gap-2">
            <Badge variant="outline">{event.eventType}</Badge>
            <span className="text-xs text-muted-foreground">
              {event.environment} · {event.actorUserId === null ? 'by a service credential' : 'by a member'}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            {new Date(event.createdAt).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}
