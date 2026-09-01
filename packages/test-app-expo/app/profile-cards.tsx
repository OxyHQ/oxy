import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { useTheme } from '@oxyhq/bloom/theme';
import { ProfileCard } from '@oxyhq/bloom/profile-card';
import type { ProfileCardProps } from '@oxyhq/bloom/profile-card';
import { DotGridMeter } from '@oxyhq/bloom/dot-grid-meter';
import { StatBar } from '@oxyhq/bloom/stat-bar';
import { ActivityHeatmap, bucketByDay } from '@oxyhq/bloom/activity-heatmap';
import { AvatarGroup } from '@oxyhq/bloom/avatar-group';
import type { AvatarGroupItem } from '@oxyhq/bloom/avatar-group';
import { CompositionBar } from '@oxyhq/bloom/composition-bar';
import type { CompositionCategory } from '@oxyhq/bloom/composition-bar';

/**
 * Profile preview cards showcase — an Apple-Watch-style gallery of the
 * @oxyhq/bloom ProfileCard and its metric primitives. Everything on this screen
 * is mock data; it exists to exercise every new component in both light and dark
 * theme. Colors come from Bloom's useTheme() so the gallery tracks the active
 * color preset like the rest of the app chrome.
 */

// Facepile members for the ProfileCard footers. `name` drives Avatar's colored
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

  // The ProfileCard variants. Each entry is rendered twice below — once as a
  // compact `widget` card and once as a full-width `wide` card — so both layouts
  // are exercised for every variant and every metric kind. Colors are vivid,
  // per-card accents (the widget surface is a committed near-black), mirroring
  // the Apple-Watch reference.
  const cards = useMemo<{ key: string; props: Omit<ProfileCardProps, 'layout'> }[]>(() => {
    // A coin-style badge pinned to a ProfileCard avatar. ProfileCard already
    // haloes it with the card surface, so the badge itself is a plain filled disc;
    // the glyph cuts out to the card background color. Colors are theme tokens.
    const coinBadge = (color: string, glyph: React.ComponentProps<typeof MaterialCommunityIcons>['name']) => (
      <View className="h-4 w-4 items-center justify-center rounded-full" style={{ backgroundColor: color }}>
        <MaterialCommunityIcons name={glyph} size={10} color={colors.background} />
      </View>
    );
    return [
      {
        key: 'wallet-dots',
        props: {
          variant: 'wallet',
          avatar: { name: 'Main Wallet', ring: { colors: colors.success }, badge: coinBadge(colors.warning, 'bitcoin') },
          value: '$167,395',
          subtitle: '*5bF5',
          metric: { kind: 'dots', label: 'Token diversity', filled: 6, total: 14, filledColor: colors.success },
          footer: { label: 'Top tokens', items: TOKEN_AVATARS.slice(0, 4), max: 4 },
        },
      },
      {
        key: 'wallet-progress',
        props: {
          variant: 'wallet',
          avatar: { name: 'Trading Wallet', ring: { colors: colors.warning }, badge: coinBadge(colors.info, 'ethereum') },
          value: '$64,395',
          subtitle: '*8Sf4',
          metric: {
            kind: 'progress',
            label: 'TX count 24h',
            value: 32,
            max: 350,
            minLabel: '32',
            maxLabel: '350',
            fillColor: colors.warning,
            icon: <MaterialCommunityIcons name="trophy" size={14} color={colors.textSecondary} />,
          },
          footer: { label: 'Top tokens', items: TOKEN_AVATARS.slice(1, 5), max: 4 },
        },
      },
      {
        key: 'wallet-split',
        props: {
          variant: 'wallet',
          avatar: { name: 'Savings Wallet', ring: { colors: colors.primary }, badge: coinBadge(colors.success, 'currency-usd') },
          value: '$96,395',
          subtitle: '*2Ac9',
          metric: {
            kind: 'split',
            label: 'Net flow 24h',
            percent: 38,
            leftValue: '$16,495',
            rightValue: '$6,305',
            fillColor: colors.primary,
          },
          footer: { label: 'Top tokens', items: TOKEN_AVATARS.slice(2, 6), max: 4 },
        },
      },
      {
        key: 'social',
        props: {
          variant: 'social',
          avatar: { name: 'Ada Lovelace', ring: { colors: colors.info }, badge: coinBadge(colors.info, 'check-bold') },
          value: 'Ada Lovelace',
          subtitle: '@ada',
          metric: { kind: 'dots', label: 'Weekly activity', filled: 12, total: 14, filledColor: colors.info },
          footer: { label: 'Followed by', items: FOLLOWER_AVATARS.slice(0, 4), max: 4 },
        },
      },
      {
        key: 'shopping',
        props: {
          variant: 'shopping',
          avatar: { name: 'Aurora Headphones', ring: { colors: colors.warning }, badge: coinBadge(colors.warning, 'star') },
          value: '$249.00',
          subtitle: 'Aurora Studio · Audio',
          metric: {
            kind: 'progress',
            label: 'In stock',
            value: 18,
            max: 50,
            minLabel: '18 left',
            maxLabel: '50',
            fillColor: colors.warning,
          },
          footer: { label: 'Recent buyers', items: FOLLOWER_AVATARS.slice(1, 5), max: 4 },
        },
      },
      {
        key: 'stat',
        props: {
          variant: 'stat',
          avatar: { name: 'Trust Score', ring: { colors: colors.info } },
          value: '742',
          subtitle: 'Trust standing',
          metric: {
            kind: 'progress',
            label: 'To next tier',
            value: 742,
            max: 1000,
            minLabel: 'Trusted',
            maxLabel: 'High trust',
            fillColor: colors.info,
          },
        },
      },
    ];
  }, [colors]);

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
          @oxyhq/bloom ProfileCard — Apple-Watch-style preview cards and their metric primitives.
        </Text>
      </View>

      {/* ── ProfileCard gallery ─────────────────────────────────────────── */}
      <SectionHeader title="ProfileCard" subtitle="Widget carousel (240dp) + full-width wide cards" />

      <Text className="mt-2 text-[12px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">Widget layout</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-3 py-1 pr-1"
      >
        {cards.map(({ key, props }) => (
          <ProfileCard key={key} layout="widget" {...props} />
        ))}
      </ScrollView>

      <Text className="mt-2 text-[12px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">Wide layout</Text>
      <View className="gap-3">
        {cards.map(({ key, props }) => (
          <ProfileCard key={key} layout="wide" {...props} />
        ))}
      </View>

      {/* ── Metric primitives ───────────────────────────────────────────── */}
      <SectionHeader title="Primitives" subtitle="The building blocks used inside ProfileCard" />

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

