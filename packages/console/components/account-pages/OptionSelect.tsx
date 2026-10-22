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

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

/** Bloom's Select composed once: a trigger showing the chosen label and a list of options. */
export function OptionSelect<T extends string>({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: {
  /** Accessible name of the control. */
  label: string;
  value: T | '';
  onChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next);
        if (option) onChange(option.value);
      }}
    >
      <SelectTrigger label={label} disabled={disabled}>
        <SelectValue placeholder={placeholder}>
          {() => options.find((option) => option.value === value)?.label ?? placeholder ?? ''}
        </SelectValue>
        <SelectIcon />
      </SelectTrigger>
      <SelectContent
        label={label}
        items={[...options]}
        valueExtractor={(item) => item.value}
        renderItem={(item) => (
          <SelectItem value={item.value} label={item.label}>
            <SelectItemIndicator />
            <SelectItemText>{item.label}</SelectItemText>
          </SelectItem>
        )}
      />
    </Select>
  );
}
