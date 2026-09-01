import { useMemo, useState } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowTurnBackwardIcon,
  ArrowUpRight01Icon,
  Layers01Icon,
  MoreHorizontalIcon,
  PackageIcon,
  RocketIcon,
  SlidersHorizontalIcon,
  Undo02Icon,
} from '@hugeicons/core-free-icons';
import { toast } from '@oxyhq/bloom';
import type { Application } from '@/hooks/use-applications';
import type { CallerAccess } from '@/hooks/use-applications';
import type { Channel, Update } from '@/hooks/use-updates';
import {
  useChannelUpdates,
  usePromoteUpdate,
  useRollbackChannel,
  useRollbackToEmbedded,
  useSetRollout,
  useUpdateChannels,
} from '@/hooks/use-updates';
import { getErrorMessage } from '@/lib/api-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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

// Channel names are URL-safe slugs (mirrors the `channelNameSchema` contract) —
// validate client-side so promote gives immediate feedback before the round-trip.
const CHANNEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** First 8 chars of the UUID — enough to identify an update at a glance. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Short git SHA (7 chars), the git convention. */
function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/** Human "n ago" from an ISO timestamp, largest sensible unit. */
function formatAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return '—';
  }
  const seconds = Math.round((Date.now() - then) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, secs] of units) {
    if (Math.abs(seconds) >= secs) {
      return rtf.format(-Math.round(seconds / secs), unit);
    }
  }
  return rtf.format(-seconds, 'second');
}

function statusVariant(status: Update['status']): 'default' | 'secondary' | 'destructive' {
  if (status === 'published') {
    return 'default';
  }
  if (status === 'rolled_back') {
    return 'destructive';
  }
  return 'secondary';
}

function platformLabel(platform: Update['platform']): string {
  return platform === 'ios' ? 'iOS' : 'Android';
}

/**
 * Reduce a channel's updates (newest first, all statuses) to the head of each
 * `(runtimeVersion, platform)` tuple — the first (newest) occurrence — then sort
 * by runtime version (desc, numeric-aware) then platform.
 */
function computeHeads(updates: Array<Update>): Array<Update> {
  const heads = new Map<string, Update>();
  for (const update of updates) {
    // Escaped NUL separator: runtime versions are free-form strings, so a
    // printable delimiter could collide across distinct (runtime, platform) pairs.
    const key = `${update.runtimeVersion}\u0000${update.platform}`;
    if (!heads.has(key)) {
      heads.set(key, update);
    }
  }
  return Array.from(heads.values()).sort((a, b) =>
    a.runtimeVersion === b.runtimeVersion
      ? a.platform.localeCompare(b.platform)
      : b.runtimeVersion.localeCompare(a.runtimeVersion, undefined, { numeric: true })
  );
}

interface UpdatesSectionProps {
  application: Application;
  access: CallerAccess;
}

export function UpdatesSection({ application, access }: UpdatesSectionProps) {
  const appId = application._id;
  const canManage = access.can('updates:manage');

  const {
    data: channels = [],
    isLoading,
    isError,
    refetch,
  } = useUpdateChannels(appId, canManage);

  if (!canManage) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        You do not have permission to manage updates for this application.
      </div>
    );
  }

  const channelNames = channels.map((channel) => channel.name);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Over-the-air updates</h2>
        <p className="text-sm text-muted-foreground">
          Release channels and the current head of each runtime &times; platform. Promote a build
          forward, or roll back instantly without a new binary.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <Skeleton.Box key={i} width="100%" height={112} borderRadius={14} />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-lg border border-border py-10 text-center">
          <p className="text-sm text-muted-foreground">Could not load update channels.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      ) : channels.length === 0 ? (
        <EmptyChannels />
      ) : (
        <div className="space-y-6">
          {channels.map((channel) => (
            <ChannelCard
              key={channel.id}
              appId={appId}
              channel={channel}
              channelNames={channelNames}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyChannels() {
  return (
    <div className="rounded-lg border border-dashed border-border py-12 text-center">
      <HugeiconsIcon icon={RocketIcon} size={40} className="text-muted-foreground mx-auto mb-3" />
      <p className="text-sm font-medium text-foreground">No updates published yet</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Channels are created the first time you publish. From your app directory, run{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          oxy-ship publish --channel production
        </code>{' '}
        to ship your first over-the-air update.
      </p>
    </div>
  );
}

interface ChannelCardProps {
  appId: string;
  channel: Channel;
  channelNames: Array<string>;
}

function ChannelCard({ appId, channel, channelNames }: ChannelCardProps) {
  const { data: updates = [], isLoading } = useChannelUpdates(appId, channel.name);
  const heads = useMemo(() => computeHeads(updates), [updates]);

  // Dialog targets — the head a pending action applies to (credentials-section
  // pattern: one dialog per action, driven by the selected row).
  const [promoteHead, setPromoteHead] = useState<Update | null>(null);
  const [rollbackHead, setRollbackHead] = useState<Update | null>(null);
  const [embeddedHead, setEmbeddedHead] = useState<Update | null>(null);
  const [rolloutHead, setRolloutHead] = useState<Update | null>(null);

  const promote = usePromoteUpdate(appId);
  const rollback = useRollbackChannel(appId);
  const rollbackToEmbedded = useRollbackToEmbedded(appId);
  const setRollout = useSetRollout(appId);

  const hasEmbeddedRollback = (head: Update): boolean =>
    channel.rollbacksToEmbedded.some(
      (entry) => entry.runtimeVersion === head.runtimeVersion && entry.platform === head.platform
    );

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <HugeiconsIcon icon={Layers01Icon} size={16} className="text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{channel.name}</span>
        <Badge variant="secondary" className="text-xs">
          {heads.length} {heads.length === 1 ? 'head' : 'heads'}
        </Badge>
      </div>

      {isLoading ? (
        <div className="space-y-2 p-4">
          {[1, 2].map((i) => (
            <Skeleton.Box key={i} width="100%" height={40} />
          ))}
        </div>
      ) : heads.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <HugeiconsIcon icon={PackageIcon} size={16} />
          No published updates on this channel.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Runtime</th>
                <th className="px-4 py-2 font-medium">Update</th>
                <th className="px-4 py-2 font-medium">Message</th>
                <th className="px-4 py-2 font-medium">Commit</th>
                <th className="px-4 py-2 font-medium">Age</th>
                <th className="px-4 py-2 font-medium">Rollout</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {heads.map((head) => (
                <tr key={head.id} className="align-middle">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-foreground">{head.runtimeVersion}</span>
                      <Badge variant="outline" className="text-xs">
                        {platformLabel(head.platform)}
                      </Badge>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-muted-foreground" title={head.id}>
                      {shortId(head.id)}
                    </span>
                  </td>
                  <td className="max-w-[16rem] px-4 py-3">
                    <span className="block truncate text-foreground" title={head.message}>
                      {head.message || <span className="text-muted-foreground">—</span>}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {head.gitCommit ? (
                      <span className="font-mono text-xs text-muted-foreground" title={head.gitCommit}>
                        {shortCommit(head.gitCommit)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                    {formatAge(head.createdAt)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-foreground">
                    {head.rolloutPercent}%
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={statusVariant(head.status)} className="text-xs capitalize">
                      {head.status.replace('_', ' ')}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label="Update actions">
                          <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem onSelect={() => setPromoteHead(head)}>
                          <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} />
                          Promote
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setRolloutHead(head)}>
                          <HugeiconsIcon icon={SlidersHorizontalIcon} size={16} />
                          Adjust rollout
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => setRollbackHead(head)}
                        >
                          <HugeiconsIcon icon={Undo02Icon} size={16} />
                          Rollback
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          disabled={hasEmbeddedRollback(head)}
                          onSelect={() => setEmbeddedHead(head)}
                        >
                          <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={16} />
                          Rollback to embedded
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PromoteDialog
        key={promoteHead?.id ?? 'promote-none'}
        head={promoteHead}
        channelNames={channelNames}
        isPending={promote.isPending}
        onClose={() => setPromoteHead(null)}
        onConfirm={async (toChannel, rolloutPercent) => {
          if (!promoteHead) {
            return;
          }
          try {
            await promote.mutateAsync({
              channel: channel.name,
              updateId: promoteHead.id,
              toChannel,
              rolloutPercent,
            });
            setPromoteHead(null);
            toast.success(`Promoted to ${toChannel}`);
          } catch (error) {
            toast.error(getErrorMessage(error, 'Failed to promote update'));
          }
        }}
      />

      <RolloutDialog
        key={rolloutHead?.id ?? 'rollout-none'}
        head={rolloutHead}
        isPending={setRollout.isPending}
        onClose={() => setRolloutHead(null)}
        onConfirm={async (rolloutPercent) => {
          if (!rolloutHead) {
            return;
          }
          try {
            await setRollout.mutateAsync({ updateId: rolloutHead.id, rolloutPercent });
            setRolloutHead(null);
            toast.success('Rollout updated');
          } catch (error) {
            toast.error(getErrorMessage(error, 'Failed to update rollout'));
          }
        }}
      />

      <AlertDialog open={!!rollbackHead} onOpenChange={(open) => !open && setRollbackHead(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back the head</AlertDialogTitle>
            <AlertDialogDescription>
              Marks the current head for {rollbackHead?.runtimeVersion} (
              {rollbackHead ? platformLabel(rollbackHead.platform) : ''}) on{' '}
              <span className="font-medium">{channel.name}</span> as rolled back. Devices fall back to
              the previous published update. Nothing is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={rollback.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!rollbackHead) {
                  return;
                }
                try {
                  await rollback.mutateAsync({
                    channel: channel.name,
                    runtimeVersion: rollbackHead.runtimeVersion,
                    platform: rollbackHead.platform,
                  });
                  setRollbackHead(null);
                  toast.success('Rolled back');
                } catch (error) {
                  toast.error(getErrorMessage(error, 'Failed to roll back'));
                }
              }}
            >
              {rollback.isPending ? 'Rolling back...' : 'Roll back'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!embeddedHead} onOpenChange={(open) => !open && setEmbeddedHead(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back to embedded</AlertDialogTitle>
            <AlertDialogDescription>
              Directs devices on {embeddedHead?.runtimeVersion} (
              {embeddedHead ? platformLabel(embeddedHead.platform) : ''}) to fall back to the update
              embedded in their binary until a newer update is published. Use this when even the
              previous OTA update is unsafe.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={rollbackToEmbedded.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!embeddedHead) {
                  return;
                }
                try {
                  await rollbackToEmbedded.mutateAsync({
                    channel: channel.name,
                    runtimeVersion: embeddedHead.runtimeVersion,
                    platform: embeddedHead.platform,
                  });
                  setEmbeddedHead(null);
                  toast.success('Rolled back to embedded');
                } catch (error) {
                  toast.error(getErrorMessage(error, 'Failed to roll back to embedded'));
                }
              }}
            >
              {rollbackToEmbedded.isPending ? 'Rolling back...' : 'Roll back to embedded'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface PromoteDialogProps {
  head: Update | null;
  channelNames: Array<string>;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (toChannel: string, rolloutPercent: number | undefined) => void;
}

function PromoteDialog({ head, channelNames, isPending, onClose, onConfirm }: PromoteDialogProps) {
  const [toChannel, setToChannel] = useState('');
  const [rollout, setRollout] = useState(100);

  // The parent keys this dialog on the head id, so each selection remounts with
  // fresh form state — no effect needed to re-seed.
  const suggestions = head ? channelNames.filter((name) => name !== head.channel) : [];

  const handleConfirm = () => {
    const trimmed = toChannel.trim();
    if (!trimmed) {
      toast.error('Enter a target channel');
      return;
    }
    if (!CHANNEL_NAME_PATTERN.test(trimmed)) {
      toast.error('Channel name must be a URL-safe slug (letters, numbers, . _ -)');
      return;
    }
    onConfirm(trimmed, rollout);
  };

  return (
    <Dialog open={!!head} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Promote update</DialogTitle>
          <DialogDescription>
            Publishes {head ? head.runtimeVersion : ''} (
            {head ? platformLabel(head.platform) : ''}) — the same signed assets — to another
            channel. The target channel is created if it does not exist.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="promote-channel" className="text-sm">
              Target channel
            </Label>
            <Input
              id="promote-channel"
              value={toChannel}
              onChange={(e) => setToChannel(e.target.value)}
              placeholder="production"
              autoComplete="off"
            />
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {suggestions.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setToChannel(name)}
                    className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="promote-rollout" className="text-sm">
                Rollout
              </Label>
              <span className="text-sm font-medium text-foreground">{rollout}%</span>
            </div>
            <Slider
              id="promote-rollout"
              value={[rollout]}
              onValueChange={(value) => setRollout(value[0] ?? 100)}
              min={0}
              max={100}
              step={1}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isPending || !toChannel.trim()}>
            {isPending ? 'Promoting...' : 'Promote'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RolloutDialogProps {
  head: Update | null;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (rolloutPercent: number) => void;
}

function RolloutDialog({ head, isPending, onClose, onConfirm }: RolloutDialogProps) {
  const [rollout, setRollout] = useState(head?.rolloutPercent ?? 100);

  return (
    <Dialog open={!!head} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust rollout</DialogTitle>
          <DialogDescription>
            The percentage of devices on {head ? head.runtimeVersion : ''} (
            {head ? platformLabel(head.platform) : ''}) that receive this update. Bucketing is
            deterministic per device, so lowering the percentage never yanks the update from devices
            that already have it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="rollout-slider" className="text-sm">
              Rollout
            </Label>
            <span className="text-sm font-medium text-foreground">{rollout}%</span>
          </div>
          <Slider
            id="rollout-slider"
            value={[rollout]}
            onValueChange={(value) => setRollout(value[0] ?? 0)}
            min={0}
            max={100}
            step={1}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(rollout)} disabled={isPending}>
            {isPending ? 'Saving...' : 'Save rollout'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
