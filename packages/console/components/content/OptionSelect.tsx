import { Label } from '@oxy.so/bloom/label';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { View } from 'react-native';

export interface SelectOption {
  value: string;
  label: string;
}

interface OptionSelectProps {
  label: string;
  value: string;
  options: ReadonlyArray<SelectOption>;
  onChange: (value: string) => void;
  /** Classes on the wrapper, usually a width. */
  className?: string;
  disabled?: boolean;
}

/** A labelled single-choice dropdown over a flat option list. */
export function OptionSelect({
  label,
  value,
  options,
  onChange,
  className,
  disabled,
}: OptionSelectProps) {
  return (
    <View className={`gap-1.5 ${className ?? ''}`}>
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger label={label} disabled={disabled}>
          <SelectValue>{() => options.find((option) => option.value === value)?.label}</SelectValue>
          <SelectIcon />
        </SelectTrigger>
        <SelectContent
          label={label}
          items={options}
          valueExtractor={(option) => option.value}
          renderItem={(option) => (
            <SelectItem value={option.value} label={option.label}>
              <SelectItemIndicator />
              <SelectItemText>{option.label}</SelectItemText>
            </SelectItem>
          )}
        />
      </Select>
    </View>
  );
}
