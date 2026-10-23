import * as Skeleton from '@oxy.so/bloom/skeleton';
import { View } from 'react-native';

import { StatsSkeleton, TableSkeleton } from '@/components/loading/ContentSkeleton';

/** Overview anatomy: balance tiles, two grouped sections side by side, a table. */
export function OverviewSkeleton() {
  return (
    <View className="gap-4" testID="billing-overview-skeleton">
      <StatsSkeleton />
      <View className="gap-4 xl:flex-row">
        <GroupSkeleton rows={5} />
        <GroupSkeleton rows={3} />
      </View>
      <TableSkeleton rows={4} columns={4} />
    </View>
  );
}

/** A grouped section: a title over rows with a label and a value. */
export function GroupSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Skeleton.Region className="min-w-0 flex-1 gap-3 p-4">
      <Skeleton.Box width="30%" height={14} borderRadius={6} />
      <View className="gap-3 rounded-2xl border border-border p-4">
        {Array.from({ length: rows }, (_, index) => (
          <View key={index} className="flex-row items-center justify-between gap-4">
            <Skeleton.Box width="35%" height={14} borderRadius={6} />
            <Skeleton.Box width="25%" height={14} borderRadius={6} />
          </View>
        ))}
      </View>
    </Skeleton.Region>
  );
}
