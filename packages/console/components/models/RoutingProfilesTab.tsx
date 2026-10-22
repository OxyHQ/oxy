import { Badge } from '@oxy.so/bloom/badge';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import type { RoutingProfile } from '@oxy.so/contracts';
import { Text, View } from 'react-native';

import { LoadingRows } from '@/components/content/LoadingRows';
import { useRoutingProfiles } from '@/hooks/use-models';
import { useTranslation } from '@/lib/i18n';
import { BadgeRow } from './BadgeRow';
import { LoadFailed } from './LoadFailed';

function RoutingProfileRow({ profile, isLast }: { profile: RoutingProfile; isLast: boolean }) {
  const { t } = useTranslation();
  const candidates = [...profile.candidates]
    .sort((left, right) => left.priority - right.priority)
    .map((candidate) => candidate.modelReference);

  return (
    <View className={`gap-3 py-6 ${isLast ? '' : 'border-b border-border'}`}>
      <View className="flex-row flex-wrap items-start justify-between gap-3">
        <View className="gap-0.5">
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-medium text-foreground">{profile.displayName}</Text>
            {profile.isProductPreset && (
              <Badge
                size="label-small"
                variant="subtle"
                content={t('modelsPage.profiles.productPreset')}
              />
            )}
          </View>
          <Text selectable className="font-mono text-xs text-muted-foreground">
            {profile.slug}
          </Text>
        </View>
        <Badge
          size="label-small"
          variant="outlined"
          content={t('modelsPage.profiles.optimises', { goal: profile.optimiseFor })}
        />
      </View>

      {profile.description !== undefined && (
        <Text className="text-sm text-muted-foreground">{profile.description}</Text>
      )}

      <Text className="text-xs text-muted-foreground">{t('modelsPage.profiles.candidates')}</Text>
      <BadgeRow items={candidates} />
    </View>
  );
}

/** Routing profiles: policy objects with their own id space, never models (ADR 0008). */
export function RoutingProfilesTab() {
  const { t } = useTranslation();
  const { data: profiles, isLoading, isError } = useRoutingProfiles();

  if (isLoading) return <LoadingRows />;
  if (isError) return <LoadFailed what={t('modelsPage.loadFailed.profiles')} />;

  const list = profiles ?? [];
  if (list.length === 0) {
    return (
      <EmptyState
        title={t('modelsPage.profiles.emptyTitle')}
        description={t('modelsPage.profiles.emptyBody')}
      />
    );
  }

  return (
    <View>
      {list.map((profile, index) => (
        <RoutingProfileRow
          key={profile.routingProfileId}
          profile={profile}
          isLast={index === list.length - 1}
        />
      ))}
    </View>
  );
}
