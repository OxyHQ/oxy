import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Badge } from '@oxy.so/bloom/badge';
import {
  DataTable,
  DataTableRowActions,
  type DataTableColumn,
  type DataTableRowActionItem,
} from '@oxy.so/bloom/data-table';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiArrowGoBackLine } from '@oxy.so/bloom/icons/RiArrowGoBackLine';
import { RiArrowRightUpLine } from '@oxy.so/bloom/icons/RiArrowRightUpLine';
import { RiArrowUpDownLine } from '@oxy.so/bloom/icons/RiArrowUpDownLine';
import { RiEqualizer3Line } from '@oxy.so/bloom/icons/RiEqualizer3Line';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import type { Channel, Update } from '@/hooks/use-updates';
import {
  useChannelUpdates,
  usePromoteUpdate,
  useRollbackChannel,
  useRollbackToEmbedded,
  useSetRollout,
} from '@/hooks/use-updates';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import {
  computeHeads,
  formatAge,
  platformLabel,
  shortCommit,
  shortId,
  statusColor,
} from '@/lib/updates';
import { PromoteDialog } from './PromoteDialog';
import { RolloutDialog } from './RolloutDialog';

type ReleaseView = 'heads' | 'history';

/**
 * One channel's releases: the head of each runtime x platform by default, or the
 * whole history. Promote, rollout, rollback and rollback-to-embedded act on a head
 * only, so history rows carry no menu.
 */
export function ChannelReleases({
  appId,
  channel,
  channelNames,
}: {
  appId: string;
  channel: Channel;
  channelNames: Array<string>;
}) {
  const { t, locale } = useTranslation();
  const { data: updates = [], isLoading, isError } = useChannelUpdates(appId, channel.name);
  const heads = useMemo(() => computeHeads(updates), [updates]);
  const headIds = useMemo(() => new Set(heads.map((head) => head.id)), [heads]);
  const [view, setView] = useState<ReleaseView>('heads');

  // The head a pending action applies to: one dialog per action, driven by the row.
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
      (entry) => entry.runtimeVersion === head.runtimeVersion && entry.platform === head.platform,
    );

  const columns = useMemo<Array<DataTableColumn<Update>>>(
    () => [
      {
        id: 'runtime',
        header: t('appsUpdates.columns.runtime'),
        minWidth: 160,
        cell: ({ row }) => (
          <View className="flex-row items-center gap-2">
            <Text className="font-mono text-sm text-foreground">{row.runtimeVersion}</Text>
            <Badge content={platformLabel(row.platform)} variant="outlined" size="label-small" />
          </View>
        ),
      },
      {
        id: 'update',
        header: t('appsUpdates.columns.update'),
        width: 110,
        cell: ({ row }) => (
          <Text className="font-mono text-xs text-muted-foreground">{shortId(row.id)}</Text>
        ),
      },
      {
        id: 'message',
        header: t('appsUpdates.columns.message'),
        minWidth: 180,
        cell: ({ row }) => (
          <Text className="text-sm text-foreground" numberOfLines={1}>
            {row.message || '—'}
          </Text>
        ),
      },
      {
        id: 'commit',
        header: t('appsUpdates.columns.commit'),
        width: 100,
        cell: ({ row }) => (
          <Text className="font-mono text-xs text-muted-foreground">
            {row.gitCommit ? shortCommit(row.gitCommit) : '—'}
          </Text>
        ),
      },
      {
        id: 'age',
        header: t('appsUpdates.columns.age'),
        width: 120,
        cell: ({ row }) => (
          <Text className="text-sm text-muted-foreground">{formatAge(row.createdAt, locale)}</Text>
        ),
      },
      {
        id: 'rollout',
        header: t('appsUpdates.columns.rollout'),
        width: 90,
        cell: ({ row }) => (
          <Text className="text-sm text-foreground">{`${row.rolloutPercent}%`}</Text>
        ),
      },
      {
        id: 'status',
        header: t('appsUpdates.columns.status'),
        width: 120,
        cell: ({ row }) => (
          <Badge
            content={row.status.replace('_', ' ')}
            variant="subtle"
            color={statusColor(row.status)}
            size="label-small"
          />
        ),
      },
      {
        id: 'actions',
        header: '',
        headerAccessibilityLabel: t('appsUpdates.actions.label'),
        align: 'end',
        width: 56,
        cell: ({ row }) => {
          if (!headIds.has(row.id)) return null;
          const menu: Array<DataTableRowActionItem> = [
            {
              icon: RiArrowRightUpLine,
              label: t('appsUpdates.actions.promote'),
              onPress: () => setPromoteHead(row),
            },
            {
              icon: RiEqualizer3Line,
              label: t('appsUpdates.actions.rollout'),
              onPress: () => setRolloutHead(row),
            },
            {
              icon: RiArrowGoBackLine,
              label: t('appsUpdates.actions.rollback'),
              onPress: () => setRollbackHead(row),
            },
            // Offering it again would be a no-op: the head is already pinned to embedded.
            ...(hasEmbeddedRollback(row)
              ? []
              : [
                  {
                    icon: RiArrowUpDownLine,
                    label: t('appsUpdates.actions.rollbackEmbedded'),
                    onPress: () => setEmbeddedHead(row),
                  },
                ]),
          ];
          return (
            <DataTableRowActions
              name={`${row.runtimeVersion} ${platformLabel(row.platform)}`}
              menuLabel={t('appsUpdates.actions.label')}
              menu={menu}
            />
          );
        },
      },
    ],
    // `hasEmbeddedRollback` closes over `channel`, which is the only thing it reads.
    [t, locale, channel, headIds],
  );

  if (isLoading) {
    return <Skeleton.Box width="100%" height={160} borderRadius={14} />;
  }

  const rows = view === 'heads' ? heads : updates;

  return (
    <>
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        accessibilityLabel={t('appsUpdates.table', { channel: channel.name })}
        title={channel.name}
        toolbar={
          <SegmentedControl
            type="radio"
            size="sm"
            label={t('appsUpdates.view.label')}
            value={view}
            onValueChange={(next: string) => setView(next as ReleaseView)}
          >
            <SegmentedControlItem value="heads">
              <SegmentedControlItemText>
                {t('appsUpdates.heads', { count: heads.length })}
              </SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="history">
              <SegmentedControlItemText>
                {t('appsUpdates.view.history', { total: updates.length })}
              </SegmentedControlItemText>
            </SegmentedControlItem>
          </SegmentedControl>
        }
        emptyState={
          <EmptyState
            variant="compact"
            title={isError ? t('appsUpdates.loadFailed') : t('appsUpdates.noPublished')}
          />
        }
        pageSize={20}
        minWidth={900}
        size="sm"
      />

      <PromoteDialog
        key={promoteHead?.id ?? 'promote-none'}
        head={promoteHead}
        channelNames={channelNames}
        isPending={promote.isPending}
        onClose={() => setPromoteHead(null)}
        onConfirm={async (toChannel, rolloutPercent) => {
          if (!promoteHead) return;
          try {
            await promote.mutateAsync({
              channel: channel.name,
              updateId: promoteHead.id,
              toChannel,
              rolloutPercent,
            });
            setPromoteHead(null);
            toast.success(t('appsUpdates.promote.done', { channel: toChannel }));
          } catch (error) {
            toast.error(getErrorMessage(error, t('appsUpdates.promote.failed')));
          }
        }}
      />

      <RolloutDialog
        key={rolloutHead?.id ?? 'rollout-none'}
        head={rolloutHead}
        isPending={setRollout.isPending}
        onClose={() => setRolloutHead(null)}
        onConfirm={async (rolloutPercent) => {
          if (!rolloutHead) return;
          try {
            await setRollout.mutateAsync({ updateId: rolloutHead.id, rolloutPercent });
            setRolloutHead(null);
            toast.success(t('appsUpdates.rollout.done'));
          } catch (error) {
            toast.error(getErrorMessage(error, t('appsUpdates.rollout.failed')));
          }
        }}
      />

      <Dialog
        open={!!rollbackHead}
        onClose={() => setRollbackHead(null)}
        title={t('appsUpdates.rollback.title')}
        description={
          rollbackHead
            ? t('appsUpdates.rollback.body', {
                runtime: rollbackHead.runtimeVersion,
                platform: platformLabel(rollbackHead.platform),
                channel: channel.name,
              })
            : ''
        }
        actions={[
          {
            label: rollback.isPending
              ? t('appsUpdates.rollback.rollingBack')
              : t('appsUpdates.rollback.submit'),
            color: 'destructive',
            loading: rollback.isPending,
            shouldCloseOnPress: false,
            onPress: async () => {
              if (!rollbackHead) return;
              try {
                await rollback.mutateAsync({
                  channel: channel.name,
                  runtimeVersion: rollbackHead.runtimeVersion,
                  platform: rollbackHead.platform,
                });
                setRollbackHead(null);
                toast.success(t('appsUpdates.rollback.done'));
              } catch (error) {
                toast.error(getErrorMessage(error, t('appsUpdates.rollback.failed')));
              }
            },
          },
          { label: t('common.cancel'), color: 'cancel' },
        ]}
      />

      <Dialog
        open={!!embeddedHead}
        onClose={() => setEmbeddedHead(null)}
        title={t('appsUpdates.embedded.title')}
        description={
          embeddedHead
            ? t('appsUpdates.embedded.body', {
                runtime: embeddedHead.runtimeVersion,
                platform: platformLabel(embeddedHead.platform),
              })
            : ''
        }
        actions={[
          {
            label: rollbackToEmbedded.isPending
              ? t('appsUpdates.rollback.rollingBack')
              : t('appsUpdates.embedded.submit'),
            color: 'destructive',
            loading: rollbackToEmbedded.isPending,
            shouldCloseOnPress: false,
            onPress: async () => {
              if (!embeddedHead) return;
              try {
                await rollbackToEmbedded.mutateAsync({
                  channel: channel.name,
                  runtimeVersion: embeddedHead.runtimeVersion,
                  platform: embeddedHead.platform,
                });
                setEmbeddedHead(null);
                toast.success(t('appsUpdates.embedded.done'));
              } catch (error) {
                toast.error(getErrorMessage(error, t('appsUpdates.embedded.failed')));
              }
            },
          },
          { label: t('common.cancel'), color: 'cancel' },
        ]}
      />
    </>
  );
}
