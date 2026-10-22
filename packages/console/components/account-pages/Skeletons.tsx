import * as Skeleton from '@oxy.so/bloom/skeleton';
import { View } from 'react-native';

/** Stacked full-width placeholders for a table or list that is loading. */
export function SkeletonRows({ count = 3, height = 44 }: { count?: number; height?: number }) {
  return (
    <View className="gap-2">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton.Box key={index} width="100%" height={height} />
      ))}
    </View>
  );
}

/** A row of figure-sized placeholders. */
export function SkeletonFigures({ count = 4, width = 128 }: { count?: number; width?: number }) {
  return (
    <View className="flex-row flex-wrap gap-12">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton.Box key={index} width={width} height={48} />
      ))}
    </View>
  );
}
