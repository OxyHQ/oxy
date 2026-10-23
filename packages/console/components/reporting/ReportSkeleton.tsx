import * as Skeleton from '@oxy.so/bloom/skeleton';
import { View } from 'react-native';

import { StatsSkeleton } from '@/components/loading/ContentSkeleton';

/** A chart card: title and readout over a plot. */
export function ChartCardSkeleton({ height = 320 }: { height?: number }) {
  return (
    <Skeleton.Region testID="chart-skeleton" className="min-w-0 flex-1 gap-4 rounded-2xl p-4">
      <View className="gap-2">
        <Skeleton.Box width="30%" height={14} borderRadius={6} />
        <Skeleton.Box width="45%" height={28} borderRadius={8} />
      </View>
      <Skeleton.Box width="100%" height={height - 96} borderRadius={12} />
    </Skeleton.Region>
  );
}

/** The overview anatomy: a StatCards row over two chart cards side by side. */
export function OverviewSkeleton() {
  return (
    <View className="gap-4" testID="overview-skeleton">
      <StatsSkeleton />
      <View className="gap-4 xl:flex-row">
        <ChartCardSkeleton />
        <ChartCardSkeleton />
      </View>
    </View>
  );
}
