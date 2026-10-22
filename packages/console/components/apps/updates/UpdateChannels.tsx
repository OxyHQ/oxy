import { useState } from 'react';
import { View } from 'react-native';
import { Admonition } from '@oxy.so/bloom/admonition';
import { CodeBlock } from '@oxy.so/bloom/code';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiRocket2Line } from '@oxy.so/bloom/icons/RiRocket2Line';
import { RiStackLine } from '@oxy.so/bloom/icons/RiStackLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { ApiState } from '@/components/loading/ApiState';
import { useAppDetail } from '@/components/apps/app-context';
import { useUpdateChannels } from '@/hooks/use-updates';
import { useTranslation } from '@/lib/i18n';
import { ChannelReleases } from './ChannelReleases';

const PUBLISH_COMMAND = 'oxy-ship publish --channel production';

/**
 * Over-the-air update channels: one pill tab per channel, each showing its releases.
 * Channels are created the first time a build is published from the CLI, so the
 * empty state says how.
 */
export function UpdateChannels() {
  const { t } = useTranslation();
  const { application, access } = useAppDetail();
  const canManage = access.can('updates:manage');
  const {
    data: channels = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useUpdateChannels(application._id, canManage);
  const [selected, setSelected] = useState<string | null>(null);

  if (!canManage) {
    return <EmptyState variant="compact" title={t('appsUpdates.noPermission')} />;
  }

  if (isLoading) {
    return <Skeleton.Box width="100%" height={200} borderRadius={14} />;
  }

  if (isError) {
    return <ApiState error={error} onRetry={() => refetch()} />;
  }

  if (channels.length === 0) {
    return (
      <View className="gap-4">
        <EmptyState
          icon={RiRocket2Line}
          variant="compact"
          title={t('appsUpdates.empty.title')}
          description={t('appsUpdates.empty.body')}
        />
        <CodeBlock code={PUBLISH_COMMAND} language="bash" copyable />
      </View>
    );
  }

  const channelNames = channels.map((channel) => channel.name);
  const current = channels.find((channel) => channel.name === selected) ?? channels[0];

  return (
    <>
      <Admonition type="info">{t('appsUpdates.description')}</Admonition>
      <Tabs
        value={current.name}
        onValueChange={setSelected}
        variant="pill"
        label={t('appsUpdates.channels')}
      >
        {channels.map((channel) => (
          <TabsTrigger
            key={channel.id}
            value={channel.name}
            label={channel.name}
            leadingIcon={RiStackLine}
          />
        ))}
      </Tabs>
      <ChannelReleases
        key={current.id}
        appId={application._id}
        channel={current}
        channelNames={channelNames}
      />
    </>
  );
}
