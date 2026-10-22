import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import {
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
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

/**
 * Small presentational pieces shared by the Inference, Store and Updates tabs of
 * an application. They carry no data and no behaviour; each one replaces a
 * hand-built bordered box or heading the Vite console repeated by class name.
 */

/** A section heading with its explanation and an optional trailing action. */
export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <View className="flex-row items-start justify-between gap-4">
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-foreground">{title}</Text>
        {description ? (
          <Text className="mt-0.5 text-sm text-muted-foreground">{description}</Text>
        ) : null}
      </View>
      {action ? <View className="shrink-0 flex-row items-center gap-2">{action}</View> : null}
    </View>
  );
}

/** A bordered surface. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <View className={`rounded-lg border border-border ${className ?? ''}`.trim()}>{children}</View>
  );
}

/** One row inside a `Panel`, separated from the one before it. */
export function PanelRow({
  children,
  first = false,
  className,
}: {
  children: ReactNode;
  first?: boolean;
  className?: string;
}) {
  return (
    <View
      className={`${first ? '' : 'border-t border-border'} px-4 py-3 ${className ?? ''}`.trim()}
    >
      {children}
    </View>
  );
}

export function MutedText({ children, small = false }: { children: ReactNode; small?: boolean }) {
  return (
    <Text className={`${small ? 'text-xs' : 'text-sm'} text-muted-foreground`}>{children}</Text>
  );
}

/** The sentence shown where a caller lacks the permission behind a whole tab. */
export function NoPermission({ children }: { children: ReactNode }) {
  return (
    <View className="items-center py-12">
      <Text className="text-center text-sm text-muted-foreground">{children}</Text>
    </View>
  );
}

/** A titled callout. */
export function Notice({
  type = 'info',
  title,
  children,
}: {
  type?: 'info' | 'warning' | 'error' | 'tip';
  title?: string;
  children?: ReactNode;
}) {
  return (
    <AdmonitionRoot type={type}>
      <AdmonitionRow>
        <AdmonitionIcon />
        <AdmonitionContent>
          {title ? <AdmonitionText style={{ fontWeight: '600' }}>{title}</AdmonitionText> : null}
          {children ? <AdmonitionText>{children}</AdmonitionText> : null}
        </AdmonitionContent>
      </AdmonitionRow>
    </AdmonitionRoot>
  );
}

export type PillTone = 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost';

/** A short status label; the tone vocabulary is the one the shared lib helpers return. */
export function Pill({ label, tone = 'default' }: { label: string; tone?: PillTone }) {
  const variant = tone === 'default' ? 'solid' : tone === 'outline' ? 'outlined' : 'subtle';
  const color = tone === 'destructive' ? 'error' : tone === 'default' ? 'primary' : 'default';
  return <Badge content={label} variant={variant} color={color} size="sm" />;
}

export interface SelectFieldItem<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

/** A labelled single-choice select over a typed list of values. */
export function SelectField<T extends string>({
  label,
  value,
  onChange,
  items,
  placeholder,
  disabled,
  invalid,
}: {
  label: string;
  value: T | '';
  onChange: (value: T) => void;
  items: ReadonlyArray<SelectFieldItem<T>>;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const selected = items.find((item) => item.value === value);
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          const item = items.find((entry) => entry.value === next);
          if (item) onChange(item.value);
        }}
      >
        <SelectTrigger label={label} className={invalid ? 'border-destructive' : undefined}>
          <SelectValue placeholder={placeholder}>
            {() => selected?.label ?? placeholder}
          </SelectValue>
          <SelectIcon />
        </SelectTrigger>
        <SelectContent
          label={label}
          items={[...items]}
          valueExtractor={(item) => item.value}
          renderItem={(item) => (
            <SelectItem value={item.value} label={item.label} disabled={item.disabled}>
              <SelectItemIndicator />
              <SelectItemText>{item.label}</SelectItemText>
            </SelectItem>
          )}
        />
      </Select>
    </View>
  );
}

/** A labelled text input with an optional help line beneath it. */
export function TextInputField({
  label,
  value,
  onChange,
  help,
  placeholder,
  disabled,
  invalid,
  inputMode,
  secret = false,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'email' | 'url';
  secret?: boolean;
  maxLength?: number;
}) {
  return (
    <View className="gap-1">
      <TextFieldInput
        label={label}
        value={value}
        onValueChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        invalid={invalid}
        inputMode={inputMode}
        secureTextEntry={secret}
        maxLength={maxLength}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete={secret ? 'off' : undefined}
        spellCheck={false}
      />
      {help ? <MutedText small>{help}</MutedText> : null}
    </View>
  );
}

/** Format an ISO timestamp for display in the viewer's locale. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}
