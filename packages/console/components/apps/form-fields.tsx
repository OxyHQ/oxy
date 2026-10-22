import { Field } from '@oxy.so/bloom/field';
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
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import type { TextInputProps } from 'react-native';
import { Text, View } from 'react-native';

/** A labelled single-line input with an optional hint line. */
export function TextInputField({
  label,
  hint,
  placeholder,
  value,
  onChangeText,
  disabled,
  invalid,
  ...rest
}: {
  label: string;
  hint?: string;
  invalid?: boolean;
  placeholder?: string;
  value: string;
  onChangeText: (value: string) => void;
  disabled?: boolean;
} & Omit<TextInputProps, 'value' | 'onChangeText' | 'placeholder'>) {
  return (
    <Field label={label} description={hint}>
      <TextFieldInput
        label={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? null}
        disabled={disabled}
        invalid={invalid}
        autoCapitalize="none"
        autoCorrect={false}
        {...rest}
      />
    </Field>
  );
}

/** A labelled multi-line input. */
export function TextAreaField({
  label,
  placeholder,
  value,
  onChangeText,
  disabled,
  maxLength,
  rows = 3,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChangeText: (value: string) => void;
  disabled?: boolean;
  maxLength?: number;
  rows?: number;
}) {
  return (
    <Textarea
      label={label}
      placeholder={placeholder}
      value={value}
      onChangeText={onChangeText}
      disabled={disabled}
      maxLength={maxLength}
      rows={rows}
    />
  );
}

/** A labelled select over typed values. */
export function ChoiceSelect<T extends string>({
  label,
  value,
  onChange,
  items,
  placeholder,
  disabled,
}: {
  label: string;
  value: T | '';
  onChange: (value: T) => void;
  items: ReadonlyArray<{ value: T; label: string }>;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label}>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          const item = items.find((candidate) => candidate.value === next);
          if (item) onChange(item.value);
        }}
      >
        <SelectTrigger label={label} disabled={disabled}>
          <SelectValue placeholder={placeholder}>
            {() => items.find((item) => item.value === value)?.label ?? value}
          </SelectValue>
          <SelectIcon />
        </SelectTrigger>
        <SelectContent
          label={label}
          items={[...items]}
          valueExtractor={(item) => item.value}
          renderItem={(item) => (
            <SelectItem value={item.value} label={item.label}>
              <SelectItemIndicator />
              <SelectItemText>{item.label}</SelectItemText>
            </SelectItem>
          )}
        />
      </Select>
    </Field>
  );
}

/** A bordered row: title, optional description, and a switch. */
export function SwitchRow({
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  accessibilityLabel,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <View className="flex-row items-center justify-between gap-3">
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium text-foreground">{title}</Text>
        {description ? <Text className="text-xs text-muted-foreground">{description}</Text> : null}
      </View>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        accessibilityLabel={accessibilityLabel ?? title}
      />
    </View>
  );
}
