import { Badge } from '@oxy.so/bloom/badge';
import { View } from 'react-native';

interface BadgeRowProps {
  items: ReadonlyArray<string>;
}

/** A wrapping row of outlined label badges. */
export function BadgeRow({ items }: BadgeRowProps) {
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {items.map((item) => (
        <Badge key={item} size="label-small" variant="outlined" content={item} />
      ))}
    </View>
  );
}
