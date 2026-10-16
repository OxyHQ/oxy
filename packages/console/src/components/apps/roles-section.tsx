import { useState } from 'react';
import { toast } from '@oxy.so/bloom/toast';
import { isApplicationPermissionKey } from '@oxy.so/contracts';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import {
  type ApplicationPermissionDeclaration,
  useApplicationRoleGrants,
  useApplicationRolePermissions,
  useDeclareApplicationPermissions,
  useGrantApplicationPermission,
  useRevokeApplicationRoleGrant,
} from '@/hooks/use-application-roles';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { getErrorMessage } from '@/lib/api-error';

/**
 * Application roles: the permissions THIS application declares about its own
 * users (`payments.operate`, …) and the people who hold them
 * (`docs/auth/application-roles.md`).
 *
 * The application's backend reads these through `@oxy.so/core/server`
 * (`requireAppPermission`), so this is where an app's operators are decided —
 * not an allow-list in the app's environment.
 *
 * Minimal on purpose: edit the vocabulary as a list and save it whole (the API
 * is declarative — a key removed here is retired and its grants revoked), grant
 * a key to a person by username, revoke a live grant. History (retired keys,
 * revoked grants) is in the API (`?includeRetired`, `?includeRevoked`).
 */
export function RolesSection({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const canManage = access.can('roles:manage');
  const appId = application._id;
  const permissions = useApplicationRolePermissions(appId, true);
  const grants = useApplicationRoleGrants(appId, true);

  if (permissions.isLoading || grants.isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  if (permissions.isError || grants.isError) {
    return (
      <Alert>
        <AlertTitle>Roles could not be loaded</AlertTitle>
        <AlertDescription>
          {getErrorMessage(permissions.error ?? grants.error, 'Try again in a moment.')}
        </AlertDescription>
      </Alert>
    );
  }

  const declared = permissions.data?.items ?? [];
  return (
    <div className="space-y-8">
      <VocabularyEditor
        key={declared.map((item) => `${item.key}:${item.description}`).join('|')}
        appId={appId}
        declared={declared.map(({ key, description }) => ({ key, description }))}
        canManage={canManage}
      />
      <GrantsPanel
        appId={appId}
        keys={declared.map((item) => item.key)}
        grants={grants.data?.items ?? []}
        canManage={canManage}
      />
    </div>
  );
}

function VocabularyEditor({
  appId,
  declared,
  canManage,
}: {
  appId: string;
  declared: ApplicationPermissionDeclaration[];
  canManage: boolean;
}) {
  const [draft, setDraft] = useState<ApplicationPermissionDeclaration[]>(declared);
  const declare = useDeclareApplicationPermissions();

  const invalid = draft.some(
    (row) => !isApplicationPermissionKey(row.key) || row.description.trim().length === 0,
  );
  const duplicate = new Set(draft.map((row) => row.key)).size !== draft.length;
  const dirty = JSON.stringify(draft) !== JSON.stringify(declared);
  const removed = declared.filter((row) => !draft.some((next) => next.key === row.key));

  const save = async () => {
    try {
      const result = await declare.mutateAsync({
        appId,
        permissions: draft.map((row) => ({
          key: row.key,
          description: row.description.trim(),
        })),
      });
      toast.success(
        result.revokedGrants > 0
          ? `Permissions saved; ${result.revokedGrants} grant(s) of retired keys revoked`
          : 'Permissions saved',
      );
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to save permissions'));
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Permissions</h2>
        <p className="text-sm text-muted-foreground">
          The powers this application recognises, spelled as dot-separated lowercase words (for
          example <code>payments.operate</code>). Only this application reads them.
        </p>
      </div>

      {draft.length === 0 && (
        <p className="text-sm text-muted-foreground">This application declares no permissions.</p>
      )}

      {draft.map((row, index) => (
        <div key={`row-${index}`} className="flex items-start gap-2">
          <div className="w-56 shrink-0 space-y-1">
            <Label htmlFor={`role-key-${index}`} className="sr-only">
              Key
            </Label>
            <Input
              id={`role-key-${index}`}
              value={row.key}
              placeholder="payments.operate"
              disabled={!canManage}
              aria-invalid={row.key.length > 0 && !isApplicationPermissionKey(row.key)}
              onChange={(event) =>
                setDraft(
                  draft.map((item, i) =>
                    i === index ? { ...item, key: event.target.value.trim() } : item,
                  ),
                )
              }
            />
          </div>
          <div className="flex-1 space-y-1">
            <Label htmlFor={`role-description-${index}`} className="sr-only">
              Description
            </Label>
            <Input
              id={`role-description-${index}`}
              value={row.description}
              placeholder="What holding it lets a person do"
              disabled={!canManage}
              onChange={(event) =>
                setDraft(
                  draft.map((item, i) =>
                    i === index ? { ...item, description: event.target.value } : item,
                  ),
                )
              }
            />
          </div>
          {canManage && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDraft(draft.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          )}
        </div>
      ))}

      {removed.length > 0 && (
        <Alert>
          <AlertTitle>Saving retires {removed.map((row) => row.key).join(', ')}</AlertTitle>
          <AlertDescription>
            Every grant of a retired permission is revoked. Declaring the key again later starts it
            with nobody holding it.
          </AlertDescription>
        </Alert>
      )}

      {canManage && (
        <div className="flex gap-3 border-t border-border pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDraft([...draft, { key: '', description: '' }])}
          >
            Add permission
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={!dirty || invalid || duplicate || declare.isPending}
          >
            {declare.isPending ? 'Saving...' : 'Save permissions'}
          </Button>
        </div>
      )}
    </section>
  );
}

function GrantsPanel({
  appId,
  keys,
  grants,
  canManage,
}: {
  appId: string;
  keys: string[];
  grants: Array<{
    id: string;
    permission: string;
    userId: string;
    username: string | null;
    grantedAt: string;
    grantReason: string | null;
  }>;
  canManage: boolean;
}) {
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState('');
  const [reason, setReason] = useState('');
  const grant = useGrantApplicationPermission();
  const revoke = useRevokeApplicationRoleGrant();

  const submit = async () => {
    try {
      await grant.mutateAsync({
        appId,
        username: username.trim().replace(/^@/, ''),
        permission,
        reason: reason.trim() || undefined,
      });
      setUsername('');
      setReason('');
      toast.success('Permission granted');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to grant the permission'));
    }
  };

  const revokeGrant = async (grantId: string) => {
    try {
      await revoke.mutateAsync({ appId, grantId });
      toast.success('Grant revoked');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to revoke the grant'));
    }
  };

  return (
    <section className="space-y-4 border-t border-border pt-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">People</h2>
        <p className="text-sm text-muted-foreground">
          Who holds each permission. A change reaches the application within 30 seconds, or at once
          for actions it checks fresh.
        </p>
      </div>

      {grants.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody holds a permission yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {grants.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm text-foreground">
                  {item.username ? `@${item.username}` : item.userId}{' '}
                  <code className="text-xs text-muted-foreground">{item.permission}</code>
                </p>
                <p className="text-xs text-muted-foreground">
                  Since {new Date(item.grantedAt).toLocaleDateString()}
                  {item.grantReason ? ` · ${item.grantReason}` : ''}
                </p>
              </div>
              {canManage && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={revoke.isPending}
                  onClick={() => void revokeGrant(item.id)}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && keys.length > 0 && (
        <div className="space-y-3 rounded-lg border border-border px-4 py-4">
          <p className="text-sm font-medium text-foreground">Grant a permission</p>
          <p className="text-xs text-muted-foreground">
            You cannot grant yourself a permission of an application your organization owns —
            another administrator has to.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="role-grant-username" className="text-sm">
                Username
              </Label>
              <Input
                id="role-grant-username"
                value={username}
                placeholder="@username"
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="role-grant-permission" className="text-sm">
                Permission
              </Label>
              <Select value={permission} onValueChange={setPermission}>
                <SelectTrigger id="role-grant-permission" className="w-full">
                  <SelectValue placeholder="Select a permission" />
                </SelectTrigger>
                <SelectContent>
                  {keys.map((key) => (
                    <SelectItem key={key} value={key}>
                      {key}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="role-grant-reason" className="text-sm">
              Reason (optional)
            </Label>
            <Input
              id="role-grant-reason"
              value={reason}
              placeholder="Why this person needs it"
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={!username.trim() || !permission || grant.isPending}
          >
            {grant.isPending ? 'Granting...' : 'Grant'}
          </Button>
        </div>
      )}
    </section>
  );
}
