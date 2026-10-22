import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

interface SectionProps {
  title?: string;
  description?: string;
  /** Right-aligned controls on the title row. */
  action?: ReactNode;
  /** The last section of a page drops its bottom hairline. */
  last?: boolean;
  tone?: 'default' | 'danger';
  children?: ReactNode;
}

/** A padded block of a page with an optional title row. */
export function Section({
  title,
  description,
  action,
  last = false,
  tone = 'default',
  children,
}: SectionProps) {
  return (
    <View className={`gap-4 px-6 py-6 ${last ? '' : 'border-b border-border'}`}>
      {title || action ? (
        <View className="flex-row flex-wrap items-start justify-between gap-4">
          <View className="min-w-0 flex-1 gap-0.5">
            {title ? (
              <Text
                className={`text-sm font-semibold ${
                  tone === 'danger' ? 'text-destructive' : 'text-foreground'
                }`}
              >
                {title}
              </Text>
            ) : null}
            {description ? (
              <Text className="max-w-2xl text-sm text-muted-foreground">{description}</Text>
            ) : null}
          </View>
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** Secondary copy under a figure or table. */
export function Note({ children }: { children: ReactNode }) {
  return <Text className="max-w-2xl text-xs text-muted-foreground">{children}</Text>;
}

/** Body copy in the muted colour, for empty and error states inside a section. */
export function Muted({ children }: { children: ReactNode }) {
  return <Text className="text-sm text-muted-foreground">{children}</Text>;
}

/** A large number with its label (and optional hint). */
export function Figure({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <View className="min-w-40 gap-0.5">
      <Text
        className="text-2xl font-semibold text-foreground"
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {value}
      </Text>
      <Text className="text-sm text-foreground">{label}</Text>
      {hint ? <Text className="max-w-56 text-xs text-muted-foreground">{hint}</Text> : null}
    </View>
  );
}

/** A wrapping row of {@link Figure}s. */
export function FigureRow({ children }: { children: ReactNode }) {
  return <View className="flex-row flex-wrap gap-x-12 gap-y-6">{children}</View>;
}

/** Label/value pair for definition lists. */
export function DefinitionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="flex-row items-center justify-between gap-4 border-b border-border pb-2">
      <Text className="text-sm text-muted-foreground">{label}</Text>
      {typeof children === 'string' ? (
        <Text className="shrink text-right text-sm text-foreground">{children}</Text>
      ) : (
        <View className="shrink items-end">{children}</View>
      )}
    </View>
  );
}

/** A bordered container; `dashed` marks an empty or informational block. */
export function Panel({ dashed = false, children }: { dashed?: boolean; children: ReactNode }) {
  return (
    <View className={`gap-1 rounded-lg border p-4 ${dashed ? 'border-dashed' : ''} border-border`}>
      {children}
    </View>
  );
}

/** A bordered list whose rows are separated by hairlines. */
export function RowList({ children }: { children: ReactNode }) {
  return <View className="overflow-hidden rounded-lg border border-border">{children}</View>;
}

/** One row of a {@link RowList}; pass `first` for the row without a top hairline. */
export function Row({ first = false, children }: { first?: boolean; children: ReactNode }) {
  return (
    <View
      className={`flex-row flex-wrap items-center justify-between gap-3 px-4 py-3 ${
        first ? '' : 'border-t border-border'
      }`}
    >
      {children}
    </View>
  );
}

/** Centered notice, for a page the caller may not read. */
export function Denied({ children }: { children: ReactNode }) {
  return (
    <View className="items-center px-6 py-12">
      <Text className="text-center text-sm text-muted-foreground">{children}</Text>
    </View>
  );
}

/** A labelled form field: caption above, control, then hint or error below. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      {children}
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      {hint && !error ? <Text className="text-xs text-muted-foreground">{hint}</Text> : null}
    </View>
  );
}
