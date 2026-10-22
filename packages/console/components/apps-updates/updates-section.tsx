import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Chip } from '@oxy.so/bloom/chip';
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
import { RiEqualizer3Line } from '@oxy.so/bloom/icons/RiEqualizer3Line';
import { RiRocket2Line } from '@oxy.so/bloom/icons/RiRocket2Line';
import { RiStackLine } from '@oxy.so/bloom/icons/RiStackLine';
import { RiArrowUpDownLine } from '@oxy.so/bloom/icons/RiArrowUpDownLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Slider } from '@oxy.so/bloom/slider';
import { toast } from '@oxy.so/bloom/toast';
import {
  MutedText,
  NoPermission,
  Panel,
  PanelRow,
  Pill,
  SectionHeader,
  TextInputField,
} from '@/components/apps-inference/ui';
import type { Application, CallerAccess } from '@/hooks/use-applications';
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
import { useTranslation } from '@/lib/i18n';
import {
  CHANNEL_NAME_PATTERN,
  computeHeads,
  formatAge,
  platformLabel,
  shortCommit,
  shortId,
  statusTone,
} from './updates-helpers';

/** Release channels and the head of each runtime x platform, with promote and rollback. */
export function UpdatesSection({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const appId = application._id;
  const canManage = access.can('updates:manage');

  const { data: channels = [], isLoading, isError, refetch } = useUpdateChannels(appId, canManage);

  if (!canManage) {
    return <NoPermission>{t('appsUpdates.noPermission')}</NoPermission>;
  }

  const channelNames = channels.map((channel) => channel.name);

  return (
    <View className="gap-6">
      <SectionHeader title={t('appsUpdates.title')} description={t('appsUpdates.description')} />

      {isLoading ? (
        <View className="gap-3">
          {[1, 2].map((i) => (
            <Skeleton.Box key={i} width="100%" height={112} borderRadius={14} />
          ))}
        </View>
      ) : isError ? (
        <EmptyState
          variant="compact"
          title={t('appsUpdates.loadFailed')}
          action={{ label: t('appsUpdates.retry'), onPress: () => refetch() }}
        />
      ) : channels.length === 0 ? (
        <EmptyState
          icon={RiRocket2Line}
          variant="compact"
          title={t('appsUpdates.empty.title')}
          description={t('appsUpdates.empty.body')}
        />
      ) : (
        <View className="gap-6">
          {channels.map((channel) => (
            <ChannelCard
              key={channel.id}
              appId={appId}
              channel={channel}
              channelNames={channelNames}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function ChannelCard({
  appId,
  channel,
  channelNames,
}: {
  appId: string;
  channel: Channel;
  channelNames: Array<string>;
}) {
  const { t, locale } = useTranslation();
  const { data: updates = [], isLoading } = useChannelUpdates(appId, channel.name);
  const heads = useMemo(() => computeHeads(updates), [updates]);

  // Dialog targets — the head a pending action applies to (one dialog per
  // action, driven by the selected row).
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
            <Pill label={platformLabel(row.platform)} tone="outline" />
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
          <Pill label={row.status.replace('_', ' ')} tone={statusTone(row.status)} />
        ),
      },
      {
        id: 'actions',
        header: '',
        headerAccessibilityLabel: t('appsUpdates.actions.label'),
        align: 'end',
        width: 56,
        cell: ({ row }) => {
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
    [t, locale, channel],
  );

  return (
    <Panel>
      <View className="flex-row items-center gap-2 border-b border-border px-4 py-3">
        <RiStackLine width={16} height={16} />
        <Text className="text-sm font-medium text-foreground">{channel.name}</Text>
        <Pill label={t('appsUpdates.heads', { count: heads.length })} tone="secondary" />
      </View>

      {isLoading ? (
        <View className="gap-2 p-4">
          {[1, 2].map((i) => (
            <Skeleton.Box key={i} width="100%" height={40} />
          ))}
        </View>
      ) : heads.length === 0 ? (
        <PanelRow first>
          <MutedText>{t('appsUpdates.noPublished')}</MutedText>
        </PanelRow>
      ) : (
        <DataTable
          rows={heads}
          columns={columns}
          getRowId={(row) => row.id}
          accessibilityLabel={t('appsUpdates.table', { channel: channel.name })}
          minWidth={900}
          size="sm"
        />
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
          if (!rolloutHead) {
            return;
          }
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
                toast.success(t('appsUpdates.embedded.done'));
              } catch (error) {
                toast.error(getErrorMessage(error, t('appsUpdates.embedded.failed')));
              }
            },
          },
          { label: t('common.cancel'), color: 'cancel' },
        ]}
      />
    </Panel>
  );
}

function RolloutSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-medium text-foreground">{label}</Text>
        <Text className="text-sm font-medium text-foreground">{`${value}%`}</Text>
      </View>
      <Slider
        value={value}
        onValueChange={(next) => onChange(Math.round(next))}
        min={0}
        max={100}
        step={1}
        accessibilityLabel={label}
      />
    </View>
  );
}

function PromoteDialog({
  head,
  channelNames,
  isPending,
  onClose,
  onConfirm,
}: {
  head: Update | null;
  channelNames: Array<string>;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (toChannel: string, rolloutPercent: number | undefined) => void;
}) {
  const { t } = useTranslation();
  const [toChannel, setToChannel] = useState('');
  const [rollout, setRollout] = useState(100);

  // The parent keys this dialog on the head id, so each selection remounts with
  // fresh form state — no effect needed to re-seed.
  const suggestions = head ? channelNames.filter((name) => name !== head.channel) : [];

  const handleConfirm = () => {
    const trimmed = toChannel.trim();
    if (!trimmed) {
      toast.error(t('appsUpdates.promote.enterChannel'));
      return;
    }
    if (!CHANNEL_NAME_PATTERN.test(trimmed)) {
      toast.error(t('appsUpdates.promote.invalidChannel'));
      return;
    }
    onConfirm(trimmed, rollout);
  };

  return (
    <Dialog
      open={!!head}
      onClose={onClose}
      title={t('appsUpdates.promote.title')}
      description={
        head
          ? t('appsUpdates.promote.body', {
              runtime: head.runtimeVersion,
              platform: platformLabel(head.platform),
            })
          : ''
      }
      actions={[
        {
          label: isPending ? t('appsUpdates.promote.promoting') : t('appsUpdates.promote.submit'),
          loading: isPending,
          disabled: !toChannel.trim(),
          shouldCloseOnPress: false,
          onPress: handleConfirm,
        },
        { label: t('common.cancel'), color: 'cancel' },
      ]}
    >
      <View className="gap-4">
        <View className="gap-2">
          <TextInputField
            label={t('appsUpdates.promote.target')}
            value={toChannel}
            onChange={setToChannel}
            placeholder="production"
          />
          {suggestions.length > 0 && (
            <View className="flex-row flex-wrap gap-1.5">
              {suggestions.map((name) => (
                <Chip key={name} size="sm" variant="outlined" onPress={() => setToChannel(name)}>
                  {name}
                </Chip>
              ))}
            </View>
          )}
        </View>
        <RolloutSlider
          label={t('appsUpdates.promote.rollout')}
          value={rollout}
          onChange={setRollout}
        />
      </View>
    </Dialog>
  );
}

function RolloutDialog({
  head,
  isPending,
  onClose,
  onConfirm,
}: {
  head: Update | null;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (rolloutPercent: number) => void;
}) {
  const { t } = useTranslation();
  const [rollout, setRollout] = useState(head?.rolloutPercent ?? 100);

  return (
    <Dialog
      open={!!head}
      onClose={onClose}
      title={t('appsUpdates.rollout.title')}
      description={
        head
          ? t('appsUpdates.rollout.body', {
              runtime: head.runtimeVersion,
              platform: platformLabel(head.platform),
            })
          : ''
      }
      actions={[
        {
          label: isPending ? t('appsUpdates.rollout.saving') : t('appsUpdates.rollout.submit'),
          loading: isPending,
          shouldCloseOnPress: false,
          onPress: () => onConfirm(rollout),
        },
        { label: t('common.cancel'), color: 'cancel' },
      ]}
    >
      <RolloutSlider
        label={t('appsUpdates.promote.rollout')}
        value={rollout}
        onChange={setRollout}
      />
    </Dialog>
  );
}
