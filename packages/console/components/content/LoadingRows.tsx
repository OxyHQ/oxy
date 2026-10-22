import * as Skeleton from '@oxy.so/bloom/skeleton';
import { View } from 'react-native';

interface LoadingRowsProps {
  rows?: number;
}

/** Placeholder rows shaped like a catalogue entry while the list loads. */
export function LoadingRows({ rows = 3 }: LoadingRowsProps) {
  return (
    <View className="gap-6 py-2" accessibilityRole="progressbar">
      {Array.from({ length: rows }, (_, index) => (
        <View key={index} className="gap-3">
          <Skeleton.Box width={192} height={20} />
          <Skeleton.Box width={256} height={16} />
          <View className="flex-row gap-8">
            <Skeleton.Box width={72} height={28} />
            <Skeleton.Box width={72} height={28} />
            <Skeleton.Box width={72} height={28} />
          </View>
        </View>
      ))}
    </View>
  );
}
