import React, { useState, useMemo, useCallback } from 'react';
import { View } from 'react-native';
import type { BaseScreenProps } from '../../types/navigation';
import { useSurfaceHeader } from '../../hooks/useSurfaceHeader';
import { Search } from '@oxy.so/bloom/search';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@oxy.so/bloom/accordion';
import { Text } from '@oxy.so/bloom/typography';
import { useI18n } from '../../hooks/useI18n';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const FAQ_KEYS = ['what', 'earn', 'lose', 'use', 'transfer', 'support'] as const;

/**
 * TrustFAQScreen
 *
 * Frequently asked questions about Oxy Trust, rendered with the shared Bloom
 * Accordion (single-expand) + Search. Styling is centralized Bloom token
 * classes; the Bloom Accordion owns its own expand/collapse animation, so no
 * `LayoutAnimation` is used here.
 */
const TrustFAQScreen: React.FC<BaseScreenProps> = () => {
  const styles = useStyles();
  const { t } = useI18n();

  useSurfaceHeader({
    title: t('trust.faq.title') || 'Trust FAQ',
    subtitle: t('trust.faq.subtitle') || 'Frequently asked questions about Oxy Trust',
  });

  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | undefined>(undefined);

  const faqs = useMemo(
    () =>
      FAQ_KEYS.map((key) => ({
        id: key,
        q: t(`trust.faq.items.${key}.q`) || '',
        a: t(`trust.faq.items.${key}.a`) || '',
      })),
    [t],
  );

  const filteredFaqs = useMemo(() => {
    if (!search.trim()) return faqs;
    const searchLower = search.toLowerCase();
    return faqs.filter(
      (faq) =>
        faq.q.toLowerCase().includes(searchLower) || faq.a.toLowerCase().includes(searchLower),
    );
  }, [search, faqs]);

  const handleAccordionChange = useCallback((value: string | string[] | undefined) => {
    setExpanded(Array.isArray(value) ? value[0] : value);
  }, []);

  return (
    <>
      <View style={styles.section}>
        <Search
          label={t('trust.faq.search') || 'Search FAQ...'}
          value={search}
          onChangeText={setSearch}
          onClearText={() => setSearch('')}
          accessibilityLabel="Search Trust FAQ"
        />
      </View>

      <View style={styles.section2}>
        {filteredFaqs.length === 0 ? (
          <Text style={styles.mutedText}>
            {t('trust.faq.noResults', { query: search }) ||
              `No FAQ items found matching "${search}"`}
          </Text>
        ) : (
          <Accordion type="single" value={expanded} onValueChange={handleAccordionChange}>
            {filteredFaqs.map((faq) => (
              <AccordionItem key={faq.id} value={faq.id}>
                <AccordionTrigger>{faq.q}</AccordionTrigger>
                <AccordionContent>
                  <Text style={styles.mutedText2}>{faq.a}</Text>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </View>
    </>
  );
};

export default React.memo(TrustFAQScreen);

const useStyles = createTokenStyles((t) => ({
  section: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 },
  section2: { paddingHorizontal: 20 },
  mutedText: { padding: 40, textAlign: 'center', color: t.mutedForeground },
  mutedText2: { color: t.mutedForeground, lineHeight: 22, fontWeight: 400 },
}));
