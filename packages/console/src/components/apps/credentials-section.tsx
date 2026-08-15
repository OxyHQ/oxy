import { useState } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Add01Icon,
  Alert02Icon,
  Copy01Icon,
  Delete02Icon,
  Key01Icon,
  RefreshIcon,
} from '@hugeicons/core-free-icons';
import { toast } from '@oxyhq/bloom/toast';
import type {Application, ApplicationCredential, ApplicationCredentialType, ApplicationEnvironment, CallerAccess} from '@/hooks/use-applications';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
import {
  availablePaymentsScopes,
  isUntrustedThirdPartyApp,
  PAYMENTS_SCOPES,
} from '@/lib/application-scopes';
import {
  useApplicationCredentials,
  useCreateCredential,
  useRevokeCredential,
  useRotateCredential,
} from '@/hooks/use-applications';

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

const CREDENTIAL_TYPES: Array<{ value: ApplicationCredentialType; label: string }> = [
  { value: 'public', label: 'Public' },
  { value: 'confidential', label: 'Confidential' },
  { value: 'service', label: 'Service' },
  { value: 'machine', label: 'API key (machine)' },
];

const ENVIRONMENTS: Array<{ value: ApplicationEnvironment; label: string }> = [
  { value: 'development', label: 'Development' },
  { value: 'staging', label: 'Staging' },
  { value: 'production', label: 'Production' },
];

function statusVariant(status: ApplicationCredential['status']): 'default' | 'secondary' | 'destructive' {
  if (status === 'active') {
    return 'default';
  }
  if (status === 'revoked') {
    return 'destructive';
  }
  return 'secondary';
}

/**
 * Credential material shown ONCE, immediately after a create or a rotate.
 *
 * Held in component state only, cleared by the "I saved my secret" button, and
 * never read back from anywhere — the credentials list the API serves carries no
 * secret field at all, so there is nothing for this component to re-render even
 * if it tried.
 *
 * `secret` and `token` are separate and both optional because exactly one of
 * them exists per credential type: `secret` for a `confidential`/`service`
 * client, `token` for a `machine` API key, neither for a `public` client.
 * Collapsing them into one field is what would let an API key's bearer token be
 * rendered under the wrong label — or a `public` client's `null` be copied to
 * the clipboard as the string "null".
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
  const [credentialToRotate, setCredentialToRotate] = useState<ApplicationCredential | null>(null);
  const [credentialToRevoke, setCredentialToRevoke] = useState<ApplicationCredential | null>(null);

  const handleCopy = async (value: string, message: string) => {
    await navigator.clipboard.writeText(value);
    toast.success(message);
  };

  const grantablePaymentsScopes = availablePaymentsScopes(application.scopes);
  const requiresPaymentsScopes =
    type === 'service' && isUntrustedThirdPartyApp(application);
  // A machine credential must name at least one scope — the API refuses a
  // scopeless one rather than defaulting it to the application's whole grant,
  // so the form has to ask.
  const isMachineType = type === 'machine';

  const resetCreateForm = () => {
    setName('');
    setType('confidential');
    setEnvironment('development');
    setSelectedScopes([]);
  };

  const handleTypeChange = (value: ApplicationCredentialType) => {
    setType(value);
    if (value === 'service') {
      setSelectedScopes(availablePaymentsScopes(application.scopes));
    } else {
      setSelectedScopes([]);
    }
  };

  const toggleScope = (scope: string, enabled: boolean) => {
    setSelectedScopes((current) => {
      if (enabled) {
        return current.includes(scope) ? current : [...current, scope];
      }
      return current.filter((item) => item !== scope);
    });
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.error('Enter a name for the credential');
      return;
    }
    if (requiresPaymentsScopes && selectedScopes.length === 0) {
      toast.error('Select at least one payments scope for service credentials');
      return;
    }
    if (isMachineType && selectedScopes.length === 0) {
      toast.error('Select at least one scope for an API key');
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
      toast.success('Credential created');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to create credential'));
    }
  };

  const handleRotate = async () => {
    if (!credentialToRotate) {
      return;
    }
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
      toast.success('Credential rotated');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to rotate credential'));
    }
  };

  const handleRevoke = async () => {
    if (!credentialToRevoke) {
      return;
    }
    try {
      await revokeCredential.mutateAsync({ appId, credentialId: credentialToRevoke._id });
      setCredentialToRevoke(null);
      toast.success('Credential revoked');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to revoke credential'));
    }
  };

  if (!canRead) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        You do not have permission to view credentials.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Credentials</h2>
          <p className="text-sm text-muted-foreground">
            Client IDs and secrets used to authenticate this application.
          </p>
        </div>
        {canCreate && (
          <Button
            size="sm"
            onClick={() => {
              resetCreateForm();
              setShowCreateDialog(true);
            }}
          >
            <HugeiconsIcon icon={Add01Icon} size={16} className="mr-2" />
            Create credential
          </Button>
        )}
      </div>

      {/* Revealed secret — shown once */}
      {revealed && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
          <div className="flex items-center gap-2 mb-2">
            <HugeiconsIcon icon={Alert02Icon} size={16} className="text-yellow-500" />
            <p className="text-sm font-semibold text-yellow-600 dark:text-yellow-500">
              Save your secret for "{revealed.credentialName}"
            </p>
          </div>
          <p className="text-xs text-yellow-600/80 dark:text-yellow-500/80 mb-3">
            This secret is shown only once. Copy and store it securely — you won't be able to view it
            again.
          </p>
          <div className="space-y-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Client ID</Label>
              <button
                onClick={() => handleCopy(revealed.publicKey, 'Client ID copied to clipboard')}
                className="flex w-full items-center gap-2 rounded bg-background/60 p-2 transition-colors hover:bg-background"
              >
                <span className="flex-1 truncate text-left font-mono text-sm text-foreground">
                  {revealed.publicKey}
                </span>
                <HugeiconsIcon icon={Copy01Icon} size={14} className="text-muted-foreground" />
              </button>
            </div>
            {/* Rendered ONLY when the credential actually has one. A `public`
                client's `secret` is null and a machine credential's is too —
                without this guard the box would show an empty value and the copy
                button would put the string "null" on the clipboard. */}
            {revealed.secret ? (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Secret</Label>
                <button
                  onClick={() => handleCopy(revealed.secret ?? '', 'Secret copied to clipboard')}
                  className="flex w-full items-center gap-2 rounded bg-background/60 p-2 transition-colors hover:bg-background"
                >
                  <span className="flex-1 truncate text-left font-mono text-sm text-foreground">
                    {revealed.secret}
                  </span>
                  <HugeiconsIcon icon={Copy01Icon} size={14} className="text-muted-foreground" />
                </button>
              </div>
            ) : null}
            {/* The machine credential's single bearer string. A separate box with
                its own label, so it can never be mistaken for the OAuth secret
                above — the two are used in completely different ways. */}
            {revealed.token ? (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  API key — send as <code>Authorization: Bearer</code>
                </Label>
                <button
                  onClick={() => handleCopy(revealed.token ?? '', 'API key copied to clipboard')}
                  className="flex w-full items-center gap-2 rounded bg-background/60 p-2 transition-colors hover:bg-background"
                >
                  <span className="flex-1 truncate text-left font-mono text-sm text-foreground">
                    {revealed.token}
                  </span>
                  <HugeiconsIcon icon={Copy01Icon} size={14} className="text-muted-foreground" />
                </button>
              </div>
            ) : null}
          </div>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setRevealed(null)}>
            I saved my secret
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <Skeleton.Box key={i} width="100%" height={64} borderRadius={14} />
          ))}
        </div>
      ) : credentials.length === 0 ? (
        <div className="py-10 text-center">
          <HugeiconsIcon
            icon={Key01Icon}
            size={40}
            className="text-muted-foreground mx-auto mb-3"
          />
          <p className="text-sm text-muted-foreground">No credentials yet.</p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {credentials.map((credential) => (
            <div key={credential._id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-foreground truncate">{credential.name}</p>
                  <Badge variant={statusVariant(credential.status)} className="text-xs capitalize">
                    {credential.status}
                  </Badge>
                  <Badge variant="outline" className="text-xs capitalize">
                    {credential.type}
                  </Badge>
                  <Badge variant="ghost" className="text-xs capitalize">
                    {credential.environment}
                  </Badge>
                </div>
                {/* For an API key the identifier a developer recognises is its
                    `oxy_sk_` prefix, not the OAuth client id it also carries.
                    Both are public; neither is the key. */}
                <button
                  onClick={() =>
                    handleCopy(
                      credential.tokenPrefix ?? credential.publicKey,
                      credential.tokenPrefix
                        ? 'API key ID copied to clipboard'
                        : 'Client ID copied to clipboard'
                    )
                  }
                  className="mt-1 flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span className="truncate">{credential.tokenPrefix ?? credential.publicKey}</span>
                  <HugeiconsIcon icon={Copy01Icon} size={12} />
                </button>
              </div>

              <div className="flex items-center gap-1">
                {canRotate && credential.status !== 'revoked' && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setCredentialToRotate(credential)}
                    aria-label="Rotate credential"
                    title="Rotate credential"
                  >
                    <HugeiconsIcon icon={RefreshIcon} size={16} />
                  </Button>
                )}
                {canRevoke && credential.status !== 'revoked' && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setCredentialToRevoke(credential)}
                    aria-label="Revoke credential"
                    title="Revoke credential"
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={16} className="text-destructive" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Credential Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create credential</DialogTitle>
            <DialogDescription>
              Generate a new client ID and secret for this application.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="credential-name" className="text-sm">
                Name
              </Label>
              <Input
                id="credential-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Production server"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="credential-type" className="text-sm">
                Type
              </Label>
              <Select
                value={type}
                onValueChange={(value) => handleTypeChange(value as ApplicationCredentialType)}
              >
                <SelectTrigger id="credential-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREDENTIAL_TYPES.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {type === 'service' && (
              <div className="space-y-2">
                <Label className="text-sm">Scopes</Label>
                {grantablePaymentsScopes.length > 0 ? (
                  <div className="space-y-3 rounded-lg border border-border p-3">
                    {PAYMENTS_SCOPES.filter((scope) =>
                      grantablePaymentsScopes.includes(scope)
                    ).map((scope) => (
                      <div key={scope} className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">{scope}</p>
                          <p className="text-xs text-muted-foreground">
                            {scope === 'payments:read'
                              ? 'Read payment intents and webhook deliveries'
                              : 'Create and manage payment intents'}
                          </p>
                        </div>
                        <Switch
                          checked={selectedScopes.includes(scope)}
                          onCheckedChange={(checked) => toggleScope(scope, checked)}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Enable payments scopes under General before creating a service credential.
                  </p>
                )}
                {requiresPaymentsScopes && (
                  <p className="text-xs text-muted-foreground">
                    Third-party applications must request payments-only scopes for service
                    credentials.
                  </p>
                )}
              </div>
            )}
            {isMachineType && (
              <div className="space-y-2">
                <Label className="text-sm">Scopes</Label>
                {application.scopes.length > 0 ? (
                  <div className="space-y-3 rounded-lg border border-border p-3">
                    {application.scopes.map((scope) => (
                      <div key={scope} className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium text-foreground">{scope}</p>
                        <Switch
                          checked={selectedScopes.includes(scope)}
                          onCheckedChange={(checked) => toggleScope(scope, checked)}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Grant this application at least one scope under General before creating an API
                    key.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  An API key is a single bearer string. It is shown once on creation and once on
                  each rotation, and can never be read back.
                </p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="credential-environment" className="text-sm">
                Environment
              </Label>
              <Select
                value={environment}
                onValueChange={(value) => setEnvironment(value as ApplicationEnvironment)}
              >
                <SelectTrigger id="credential-environment" className="w-full">
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={
                createCredential.isPending ||
                !name.trim() ||
                (requiresPaymentsScopes && selectedScopes.length === 0) ||
                (isMachineType && selectedScopes.length === 0)
              }
            >
              {createCredential.isPending ? 'Creating...' : 'Create credential'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate Confirmation */}
      <AlertDialog
        open={!!credentialToRotate}
        onOpenChange={(open) => !open && setCredentialToRotate(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate credential</AlertDialogTitle>
            <AlertDialogDescription>
              Rotating "{credentialToRotate?.name}" generates a new secret and invalidates the
              current one. Update your application before rotating.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRotate} disabled={rotateCredential.isPending}>
              {rotateCredential.isPending ? 'Rotating...' : 'Rotate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke Confirmation */}
      <AlertDialog
        open={!!credentialToRevoke}
        onOpenChange={(open) => !open && setCredentialToRevoke(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke credential</AlertDialogTitle>
            <AlertDialogDescription>
              Revoking "{credentialToRevoke?.name}" permanently disables it. Any application using it
              will stop working. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRevoke}
              disabled={revokeCredential.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revokeCredential.isPending ? 'Revoking...' : 'Revoke'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
