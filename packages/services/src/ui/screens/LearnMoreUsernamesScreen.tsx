import type React from 'react';
import { useCallback, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@oxy.so/bloom/accordion';
// Per glyph, never `@oxy.so/bloom/icons`. That barrel re-exports all 461 Remix
// glyphs and Metro does not tree-shake, so one import of it here re-ships every
// glyph — 313,123 B, measured — to every app in this package's graph, and no
// consumer can opt out of what a dependency asks for.
import { RiAtLine } from '@oxy.so/bloom/icons/RiAtLine';
import { RiKey2Line } from '@oxy.so/bloom/icons/RiKey2Line';
import { RiListUnordered } from '@oxy.so/bloom/icons/RiListUnordered';
import { RiResetRightLine } from '@oxy.so/bloom/icons/RiResetRightLine';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
// `Props` has no per-glyph subpath and needs none: `import type` is erased
// before any bundler sees it, so the barrel is named here and never loaded.
import type { Props as IconProps } from '@oxy.so/bloom/icons';
import type { BaseScreenProps } from '../types/navigation';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { createTokenStyles } from '@oxy.so/bloom/theme';

interface InfoSection {
  id: string;
  titleKey: string;
  contentKey: string;
  Icon: React.ComponentType<IconProps>;
}

const INFO_SECTIONS: InfoSection[] = [
  {
    id: 'what',
    titleKey: 'learnMoreUsernames.sections.what.title',
    contentKey: 'learnMoreUsernames.sections.what.content',
    Icon: RiAtLine,
  },
  {
    id: 'rules',
    titleKey: 'learnMoreUsernames.sections.rules.title',
    contentKey: 'learnMoreUsernames.sections.rules.content',
    Icon: RiListUnordered,
  },
  {
    id: 'unique',
    titleKey: 'learnMoreUsernames.sections.unique.title',
    contentKey: 'learnMoreUsernames.sections.unique.content',
    Icon: RiKey2Line,
  },
  {
    id: 'change',
    titleKey: 'learnMoreUsernames.sections.change.title',
    contentKey: 'learnMoreUsernames.sections.change.content',
    Icon: RiResetRightLine,
  },
  {
    id: 'tips',
    titleKey: 'learnMoreUsernames.sections.tips.title',
    contentKey: 'learnMoreUsernames.sections.tips.content',
    Icon: RiSparklingLine,
  },
];

const LearnMoreUsernamesScreen: React.FC<BaseScreenProps> = ({ onClose, goBack }) => {
  const themed = useThemedStyles();
  const bloomTheme = useTheme();
  const { t } = useI18n();

  useSurfaceHeader({ title: t('learnMoreUsernames.introTitle') });
  // Start with the first section expanded.
  const [expandedIds, setExpandedIds] = useState<string[]>(['what']);

  const handleAccordionChange = useCallback((value: string | string[] | undefined) => {
    if (Array.isArray(value)) {
      setExpandedIds(value);
    } else if (value == null) {
      setExpandedIds([]);
    } else {
      setExpandedIds([value]);
    }
  }, []);

  return (
    <>
      <View style={styles.section}>
        <View style={styles.container}>
          <IconCircle icon={RiAtLine} />
          <Text style={themed.mutedText}>{t('learnMoreUsernames.introText')}</Text>
        </View>

        <Accordion type="multiple" value={expandedIds} onValueChange={handleAccordionChange}>
          {INFO_SECTIONS.map(({ id, titleKey, contentKey, Icon }) => (
            <AccordionItem key={id} value={id}>
              <AccordionTrigger
                icon={
                  <View style={[themed.surface, styles.iconSquare]}>
                    <Icon size="md" style={{ color: bloomTheme.colors.primary }} />
                  </View>
                }
              >
                {t(titleKey)}
              </AccordionTrigger>
              <AccordionContent>
                <Text style={themed.mutedText2}>{t(contentKey)}</Text>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>

        <Text style={themed.mutedText3}>{t('learnMoreUsernames.footer')}</Text>
      </View>
    </>
  );
};

// Measured layout only (no color): fixed-size square that hosts the leading
// section icon inside the accordion trigger. Color comes from the
// `bg-fill-secondary` token class on the View.
const styles = StyleSheet.create({
  iconSquare: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },

  section: { paddingHorizontal: 20, paddingBottom: 32 },
  container: { alignItems: 'center', gap: 12, paddingVertical: 24 },
});

export default LearnMoreUsernamesScreen;

const useThemedStyles = createTokenStyles((t) => ({
  mutedText: { textAlign: 'center', color: t.mutedForeground, lineHeight: 22, fontWeight: 400 },
  surface: { borderRadius: 12, backgroundColor: t.muted },
  mutedText2: { color: t.mutedForeground, lineHeight: 22, fontWeight: 400 },
  mutedText3: {
    marginTop: 16,
    textAlign: 'center',
    color: t.mutedForeground,
    lineHeight: 14,
    fontWeight: 400,
  },
}));
