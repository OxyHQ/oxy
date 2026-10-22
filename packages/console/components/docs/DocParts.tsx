import { Badge } from '@oxy.so/bloom/badge';
import { CodeBlock } from '@oxy.so/bloom/code';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { type Href, Link } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { ContentScreen } from '@/components/content/ContentScreen';
import { RichText } from '@/components/content/RichText';
import { useTranslation } from '@/lib/i18n';

interface DocPageProps {
  title: string;
  subtitle: string;
  /** Header accessory, e.g. the HTTP verb badge. */
  actions?: ReactNode;
  children: ReactNode;
}

/** A documentation page: the shared content frame with a back link to the docs index. */
export function DocPage({ title, subtitle, actions, children }: DocPageProps) {
  return (
    <ContentScreen
      title={title}
      subtitle={subtitle}
      backHref="/documentation"
      actions={actions}
      maxWidth="lg"
    >
      {children}
    </ContentScreen>
  );
}

interface DocSectionProps {
  title?: string;
  children: ReactNode;
  /** Draw the rule under the section. Default true. */
  divider?: boolean;
}

/** A titled section of a documentation page, set off by a rule. */
export function DocSection({ title, children, divider = true }: DocSectionProps) {
  return (
    <View className={`gap-4 pb-6 ${divider ? 'border-b border-border' : ''}`}>
      {title !== undefined && (
        <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
          {title}
        </Text>
      )}
      {children}
    </View>
  );
}

/** A sub-heading inside a section. */
export function DocHeading({ children }: { children: string }) {
  return (
    <Text accessibilityRole="header" className="mt-2 text-base font-semibold text-foreground">
      {children}
    </Text>
  );
}

/** A paragraph of rich text (see `RichText`). */
export function DocP({ children }: { children: string }) {
  return <RichText>{children}</RichText>;
}

interface DocCodeProps {
  code: string;
  language?: string;
  /** Header caption, e.g. `index.js` or `cURL`. */
  title?: string;
}

/** A copyable code sample. Bloom highlights js/ts; other languages render as plain text. */
export function DocCode({ code, language, title }: DocCodeProps) {
  return <CodeBlock code={code} language={language} filename={title} lineNumbers={false} />;
}

interface ParamRowProps {
  name: string;
  type: string;
  required?: boolean;
  /** Rich-text description. */
  children: string;
}

/** One documented request or response field. */
export function ParamRow({ name, type, required, children }: ParamRowProps) {
  const { t } = useTranslation();
  return (
    <View className="gap-1 border-b border-border py-4">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text selectable className="font-mono text-sm font-medium text-foreground">
          {name}
        </Text>
        <Badge size="label-small" variant="outlined" content={type} />
        {required === true && (
          <Badge size="label-small" variant="subtle" content={t('docs.common.required')} />
        )}
      </View>
      <RichText>{children}</RichText>
    </View>
  );
}

interface NextStep {
  href: Href;
  label: string;
}

/** The "Next steps" list closing a page. */
export function DocNextSteps({ steps }: { steps: ReadonlyArray<NextStep> }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View className="gap-2">
      <Text accessibilityRole="header" className="text-sm font-semibold text-foreground">
        {t('docs.common.nextSteps')}
      </Text>
      <View>
        {steps.map((step) => (
          <Link key={step.label} href={step.href} asChild>
            <Pressable
              accessibilityRole="link"
              className="flex-row items-center justify-between rounded-lg px-3 py-3 hover:bg-muted"
            >
              <Text className="text-sm text-foreground">{step.label}</Text>
              <RiArrowRightSLine width={16} height={16} fill={colors.textSecondary} />
            </Pressable>
          </Link>
        ))}
      </View>
    </View>
  );
}
