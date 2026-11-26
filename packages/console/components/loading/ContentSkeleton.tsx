import * as Skeleton from '@oxy.so/bloom/skeleton';
import { View } from 'react-native';

/** Console content anatomy; Bloom owns animation, accessibility and responsive layout. */

export function ListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <Skeleton.Region testID="list-skeleton" style={{ width: '100%' }}>
      {Array.from({ length: count }, (_, index) => (
        <View key={index} className="flex-row items-center gap-3 border-b border-border px-4 py-4">
          <Skeleton.Circle size={40} />
          <View className="flex-1 gap-2">
            <Skeleton.Box width="55%" height={16} borderRadius={6} />
            <Skeleton.Box width="80%" height={12} borderRadius={6} />
          </View>
        </View>
      ))}
    </Skeleton.Region>
  );
}

export function TableSkeleton({ rows = 6, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <Skeleton.Region testID="table-skeleton" style={{ width: '100%' }}>
      <View className="flex-row gap-4 border-b border-border px-4 py-3">
        {Array.from({ length: columns }, (_, column) => (
          <View key={column} className="flex-1">
            <Skeleton.Box width="50%" height={12} borderRadius={6} />
          </View>
        ))}
      </View>
      {Array.from({ length: rows }, (_, row) => (
        <View key={row} className="flex-row gap-4 border-b border-border px-4 py-4">
          {Array.from({ length: columns }, (_, column) => (
            <View key={column} className="flex-1">
              <Skeleton.Box width={column === 0 ? '75%' : '55%'} height={14} borderRadius={6} />
            </View>
          ))}
        </View>
      ))}
    </Skeleton.Region>
  );
}

export function FormSkeleton({ count = 4 }: { count?: number }) {
  return (
    <Skeleton.Region testID="form-skeleton" style={{ width: '100%', gap: 20, padding: 16 }}>
      {Array.from({ length: count }, (_, index) => (
        <View key={index} className="gap-2">
          <Skeleton.Box width="34%" height={14} borderRadius={6} />
          <Skeleton.Box width="100%" height={index === 1 ? 96 : 44} borderRadius={12} />
        </View>
      ))}
    </Skeleton.Region>
  );
}

export function DetailSkeleton() {
  return (
    <Skeleton.Region testID="detail-skeleton" style={{ width: '100%', gap: 20, padding: 16 }}>
      <Skeleton.Box width="60%" height={28} borderRadius={8} />
      <Skeleton.Box width="40%" height={14} borderRadius={6} />
      <Skeleton.Box width="100%" height={160} borderRadius={16} />
      {[0, 1, 2, 3].map((index) => (
        <Skeleton.Box
          key={index}
          width={index === 3 ? '65%' : '100%'}
          height={14}
          borderRadius={6}
        />
      ))}
    </Skeleton.Region>
  );
}

/** A StatCards row: `count` tiles with a label, a value and a delta line. */
export function StatsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <Skeleton.Region
      testID="stats-skeleton"
      style={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: 12, padding: 16 }}
    >
      {Array.from({ length: count }, (_, index) => (
        <View
          key={index}
          className="min-w-[160px] flex-1 gap-3 rounded-2xl border border-border p-4"
        >
          <Skeleton.Box width="45%" height={12} borderRadius={6} />
          <Skeleton.Box width="65%" height={28} borderRadius={8} />
          <Skeleton.Box width="35%" height={12} borderRadius={6} />
        </View>
      ))}
    </Skeleton.Region>
  );
}
