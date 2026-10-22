import {
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
} from '@oxy.so/bloom/admonition';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import * as Clipboard from 'expo-clipboard';
import type { ComponentType, ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

/** A titled block of an application section: heading, one explanatory line, then content. */
export function SectionBlock({
  title,
  description,
  danger = false,
  bordered = false,
  action,
  children,
}: {
  title: string;
  description?: string;
  danger?: boolean;
  /** Draw a rule above the block, separating it from the one before. */
  bordered?: boolean;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <View className={bordered ? 'gap-4 border-t border-border pt-6' : 'gap-4'}>
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text
            className={
              danger
                ? 'text-sm font-semibold text-error-text'
                : 'text-sm font-semibold text-foreground'
            }
          >
            {title}
          </Text>
          {description ? (
            <Text className="text-sm text-muted-foreground">{description}</Text>
          ) : null}
        </View>
        {action}
      </View>
      {children}
    </View>
  );
}

/** A glyph in the secondary text colour (Bloom icons paint with the primary accent by default). */
export function MutedIcon({
  icon: Icon,
  size = 16,
  tone = 'textSecondary',
}: {
  icon: ComponentType<{ fill?: string; width?: number; height?: number }>;
  size?: number;
  tone?: 'textSecondary' | 'warning' | 'negative';
}) {
  const { colors } = useTheme();
  return <Icon fill={colors[tone]} width={size} height={size} />;
}

/** A bordered group of rows. */
export function RowGroup({ children }: { children: ReactNode }) {
  return <View className="overflow-hidden rounded-lg border border-border">{children}</View>;
}

/** A monospaced inline token (permission, header name). */
export function Code({ children }: { children: ReactNode }) {
  return <Text className="font-mono text-xs text-foreground">{children}</Text>;
}

export async function copyToClipboard(value: string, message: string): Promise<void> {
  await Clipboard.setStringAsync(value);
  toast.success(message);
}

/** A monospaced value that copies itself on press. */
export function CopyValue({
  value,
  copiedMessage,
  label,
  large = false,
}: {
  value: string;
  copiedMessage: string;
  label: string;
  large?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => void copyToClipboard(value, copiedMessage)}
      className="flex-row items-center gap-2 rounded-md bg-muted px-2 py-2"
    >
      <Text
        selectable
        numberOfLines={1}
        className={
          large
            ? 'min-w-0 flex-1 font-mono text-sm text-foreground'
            : 'min-w-0 flex-1 font-mono text-xs text-foreground'
        }
      >
        {value}
      </Text>
      <MutedIcon icon={RiFileCopyLine} size={14} />
    </Pressable>
  );
}

/** A callout with a bold title and body copy (Bloom admonition). */
export function Notice({
  type = 'info',
  title,
  children,
}: {
  type?: 'info' | 'tip' | 'warning' | 'error';
  title: string;
  children?: ReactNode;
}) {
  return (
    <AdmonitionRoot type={type}>
      <AdmonitionRow>
        <AdmonitionIcon />
        <AdmonitionContent>
          <Text className="text-sm font-semibold text-foreground">{title}</Text>
          {children}
        </AdmonitionContent>
      </AdmonitionRow>
    </AdmonitionRoot>
  );
}

/** Body paragraph inside a `Notice`. */
export function NoticeText({ children }: { children: ReactNode }) {
  return <Text className="text-sm text-muted-foreground">{children}</Text>;
}
