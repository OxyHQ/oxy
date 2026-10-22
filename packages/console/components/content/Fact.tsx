import { Text, View } from 'react-native';

interface FactProps {
  label: string;
  value: string;
  hint?: string;
}

/** One labelled figure: a caption above a medium-weight value. */
export function Fact({ label, value, hint }: FactProps) {
  return (
    <View className="gap-0.5">
      <Text className="text-xs text-muted-foreground">{label}</Text>
      <Text selectable className="text-sm font-medium text-foreground">
        {value}
      </Text>
      {hint !== undefined && <Text className="text-xs text-muted-foreground">{hint}</Text>}
    </View>
  );
}
