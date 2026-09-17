import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { useTheme } from '@oxy.so/bloom/theme';
import { DotGridMeter } from '@oxy.so/bloom/dot-grid-meter';
import { StatBar } from '@oxy.so/bloom/stat-bar';
import { ActivityHeatmap, bucketByDay } from '@oxy.so/bloom/activity-heatmap';
import { AvatarGroup } from '@oxy.so/bloom/avatar-group';
import type { AvatarGroupItem } from '@oxy.so/bloom/avatar-group';
import { CompositionBar } from '@oxy.so/bloom/composition-bar';
import type { CompositionCategory } from '@oxy.so/bloom/composition-bar';

/**
 * Profile metric primitives showcase — a gallery of the @oxy.so/bloom metric
 * components (DotGridMeter, StatBar, ActivityHeatmap, CompositionBar,
 * AvatarGroup). Everything on this screen is mock data; it exists to exercise
 * the components in both light and dark theme. Colors come from Bloom's
 * useTheme() so the gallery tracks the active color preset like the rest of the
 * app chrome. (Bloom 2.0 removed ProfileCard, so its gallery is gone.)
 */

// Facepile members for the AvatarGroup demos. `name` drives Avatar's colored
// initial placeholder — no real image URLs are needed for the showcase.
const TOKEN_AVATARS: AvatarGroupItem[] = [
  { id: 'btc', name: 'Bitcoin' },
  { id: 'eth', name: 'Ethereum' },
  { id: 'sol', name: 'Solana' },
  { id: 'usdc', name: 'USD Coin' },
  { id: 'ada', name: 'Cardano' },
  { id: 'dot', name: 'Polkadot' },
];

const FOLLOWER_AVATARS: AvatarGroupItem[] = [
  { id: 'u1', name: 'Ada Lovelace' },
  { id: 'u2', name: 'Grace Hopper' },
  { id: 'u3', name: 'Alan Turing' },
  { id: 'u4', name: 'Katherine Johnson' },
  { id: 'u5', name: 'Linus Torvalds' },
];

// Illustrative reputation composition for the CompositionBar demo. Colors are
// mock palette values, not theme tokens — each segment needs a distinct hue.
const COMPOSITION: CompositionCategory[] = [
  { key: 'content', name: 'Content', amount: 320, color: '#8B5CF6' },
  { key: 'social', name: 'Social', amount: 180, color: '#EC4899' },
  { key: 'trust', name: 'Trust', amount: 140, color: '#10B981' },
  { key: 'physical', name: 'Physical', amount: 90, color: '#F59E0B' },
  { key: 'moderation', name: 'Moderation', amount: 60, color: '#3B82F6' },
];

export default function ProfileCardsScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [selectedCategory, setSelectedCategory] = useState<string | null>('trust');

  // Deterministic ~17 weeks of activity so the heatmap renders a stable gradient
  // in both themes. bucketByDay counts the generated timestamps per calendar day.
  const heatmapData = useMemo(() => {
    const now = new Date();
    const events: { ts: Date }[] = [];
    for (let dayOffset = 0; dayOffset < 119; dayOffset += 1) {
      const day = new Date(now);
      day.setDate(now.getDate() - dayOffset);
      const count = Math.max(0, Math.round((Math.sin(dayOffset / 5) + Math.cos(dayOffset / 11)) * 2 + 2));
      for (let i = 0; i < count; i += 1) events.push({ ts: new Date(day) });
    }
    return bucketByDay(events, (event) => event.ts);
  }, []);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  return (
    <ScrollView
      className="bg-background"
      contentContainerClassName="px-4 pt-4 gap-3"
      contentContainerStyle={{ paddingBottom: insets.bottom + 48 }}
    >
      <View className="mb-1 gap-1.5">
        <Text className="text-[30px] font-extrabold tracking-[-0.5px] text-foreground">Profile preview cards</Text>
        <Text className="text-[15px] leading-[21px] text-muted-foreground">
          @oxy.so/bloom metric primitives for profile previews.
        </Text>
      </View>

      {/* ── Metric primitives ───────────────────────────────────────────── */}
      <SectionHeader title="Primitives" subtitle="Metric building blocks for profile previews" />

      <Card label="DotGridMeter">
        <DotGridMeter filled={13} total={30} columns={10} filledColor={colors.success} />
      </Card>

      <Card label="StatBar · progress">
        <StatBar
          variant="progress"
          label="TX count 24h"
          value={128}
          max={350}
          minLabel="128"
          maxLabel="350"
          icon={<MaterialCommunityIcons name="trophy" size={14} color={colors.warning} />}
          fillColor={colors.primary}
        />
      </Card>

      <Card label="StatBar · split">
        <StatBar
          variant="split"
          label="Net flow 24h"
          percent={62}
          leftValue="$16,495"
          rightValue="$6,305"
          fillColor={colors.success}
        />
      </Card>

      <Card label="ActivityHeatmap">
        <ActivityHeatmap data={heatmapData} endDate={today} numDays={119} />
      </Card>

      <Card label="CompositionBar">
        <CompositionBar
          categories={COMPOSITION}
          selectedKey={selectedCategory}
          onSelect={setSelectedCategory}
          hintLabel="Tap a segment to inspect reputation by category"
        />
      </Card>

      <Card label={'AvatarGroup · layout="row"'}>
        <AvatarGroup items={TOKEN_AVATARS} layout="row" size={36} spacing={8} max={6} />
      </Card>

      <Card label={'AvatarGroup · layout="stack"'}>
        <AvatarGroup items={FOLLOWER_AVATARS} layout="stack" size={36} max={4} total={128} />
      </Card>
    </ScrollView>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View className="mb-1 mt-5 gap-0.5">
      <Text className="text-[22px] font-bold tracking-[-0.3px] text-foreground">{title}</Text>
      <Text className="text-[13px] leading-[18px] text-muted-foreground">{subtitle}</Text>
    </View>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="gap-3 rounded-2xl border border-border bg-background p-4">
      <Text className="text-[12px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">{label}</Text>
      {children}
    </View>
  );
}

