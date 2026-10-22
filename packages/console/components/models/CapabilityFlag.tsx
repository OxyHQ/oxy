import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text, View } from 'react-native';

interface CapabilityFlagProps {
  label: string;
  supported: boolean;
}

/** A capability a model has or lacks: a check or a cross beside its name. */
export function CapabilityFlag({ label, supported }: CapabilityFlagProps) {
  const { colors } = useTheme();
  const Icon = supported ? RiCheckboxCircleLine : RiCloseCircleLine;
  return (
    <View className="flex-row items-center gap-1.5">
      <Icon width={14} height={14} fill={supported ? colors.success : colors.textSecondary} />
      <Text className={supported ? 'text-sm text-foreground' : 'text-sm text-muted-foreground'}>
        {label}
      </Text>
    </View>
  );
}
