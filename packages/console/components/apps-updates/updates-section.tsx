import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Badge } from '@oxy.so/bloom/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Chip } from '@oxy.so/bloom/chip';
import {
  DataTable,
  DataTableRowActions,
  type DataTableColumn,
  type DataTableRowActionItem,
} from '@oxy.so/bloom/data-table';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Field } from '@oxy.so/bloom/field';
import { RiArrowGoBackLine } from '@oxy.so/bloom/icons/RiArrowGoBackLine';
import { RiArrowRightUpLine } from '@oxy.so/bloom/icons/RiArrowRightUpLine';
import { RiEqualizer3Line } from '@oxy.so/bloom/icons/RiEqualizer3Line';
import { RiRocket2Line } from '@oxy.so/bloom/icons/RiRocket2Line';
import { RiStackLine } from '@oxy.so/bloom/icons/RiStackLine';
import { RiArrowUpDownLine } from '@oxy.so/bloom/icons/RiArrowUpDownLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Slider } from '@oxy.so/bloom/slider';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
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
  statusColor,
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
    return <EmptyState variant="compact" title={t('appsUpdates.noPermission')} />;
  }

  const channelNames = channels.map((channel) => channel.name);

  return (
    <View className="gap-6">
      <View>
        <CardTitle>{t('appsUpdates.title')}</CardTitle>
        <CardDescription>{t('appsUpdates.description')}</CardDescription>
      </View>

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
    <Card appearance="outline" radius="radius-16">
      <CardHeader>
        <View className="flex-row items-center gap-2">
          <RiStackLine width={16} height={16} />
          <CardTitle>{channel.name}</CardTitle>
          <Badge
            content={t('appsUpdates.heads', { count: heads.length })}
            variant="subtle"
            size="label-small"
          />
        </View>
      </CardHeader>

      {isLoading ? (
        <CardBody>
          <View className="gap-2">
            {[1, 2].map((i) => (
              <Skeleton.Box key={i} width="100%" height={40} />
            ))}
          </View>
        </CardBody>
      ) : heads.length === 0 ? (
        <CardBody>
          <CardDescription>{t('appsUpdates.noPublished')}</CardDescription>
        </CardBody>
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
    </Card>
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
          <Field label={t('appsUpdates.promote.target')}>
            <TextFieldInput
              label={t('appsUpdates.promote.target')}
              value={toChannel}
              onValueChange={setToChannel}
              placeholder="production"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
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
        <Field label={t('appsUpdates.promote.rollout')} description={`${rollout}%`}>
          <Slider
            value={rollout}
            onValueChange={(next) => setRollout(Math.round(next))}
            min={0}
            max={100}
            step={1}
            accessibilityLabel={t('appsUpdates.promote.rollout')}
          />
        </Field>
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
      <Field label={t('appsUpdates.promote.rollout')} description={`${rollout}%`}>
        <Slider
          value={rollout}
          onValueChange={(next) => setRollout(Math.round(next))}
          min={0}
          max={100}
          step={1}
          accessibilityLabel={t('appsUpdates.promote.rollout')}
        />
      </Field>
    </Dialog>
  );
}
