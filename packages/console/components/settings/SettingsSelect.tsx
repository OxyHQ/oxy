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

/** The compact select composition used by Bloom's SettingsGeneralPage template. */
export function SettingsSelect<T extends string>({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  items: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const item = items.find((candidate) => candidate.value === next);
        if (item) onChange(item.value);
      }}
    >
      <SelectTrigger label={label} className="gap-1 px-2 py-1.5">
        <SelectValue>
          {(selected) => {
            const key =
              typeof selected === 'object' && selected !== null && 'value' in selected
                ? selected.value
                : selected;
            return items.find((item) => item.value === key)?.label ?? String(key);
          }}
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
  );
}
