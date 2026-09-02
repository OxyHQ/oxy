import React, { useState, useMemo, useCallback } from 'react';
import { View } from 'react-native';
import type { BaseScreenProps } from '../../types/navigation';
import { useSurfaceHeader } from '../../hooks/useSurfaceHeader';
import { Search } from '@oxyhq/bloom/search';
import {
    Accordion,
    AccordionItem,
    AccordionTrigger,
    AccordionContent,
} from '@oxyhq/bloom/accordion';
import { Text } from '@oxyhq/bloom/typography';
import { useI18n } from '../../hooks/useI18n';

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
    const { t } = useI18n();

    useSurfaceHeader({
        title: t('trust.faq.title') || 'Trust FAQ',
        subtitle: t('trust.faq.subtitle') || 'Frequently asked questions about Oxy Trust',
    });

    const [search, setSearch] = useState('');
    const [expanded, setExpanded] = useState<string | undefined>(undefined);

    const faqs = useMemo(() => FAQ_KEYS.map(key => ({
        id: key,
        q: t(`trust.faq.items.${key}.q`) || '',
        a: t(`trust.faq.items.${key}.a`) || '',
    })), [t]);

    const filteredFaqs = useMemo(() => {
        if (!search.trim()) return faqs;
        const searchLower = search.toLowerCase();
        return faqs.filter(faq =>
            faq.q.toLowerCase().includes(searchLower) ||
            faq.a.toLowerCase().includes(searchLower)
        );
    }, [search, faqs]);

    const handleAccordionChange = useCallback(
        (value: string | string[] | undefined) => {
            setExpanded(Array.isArray(value) ? value[0] : value);
        },
        [],
    );

    return (
        <>
            <View className="px-screen-margin pt-space-20 pb-space-12">
                <Search
                    label={t('trust.faq.search') || 'Search FAQ...'}
                    value={search}
                    onChangeText={setSearch}
                    onClearText={() => setSearch('')}
                    accessibilityLabel="Search Trust FAQ"
                />
            </View>

            <View className="px-screen-margin">
                {filteredFaqs.length === 0 ? (
                    <Text className="text-text-secondary text-center p-space-40">
                        {t('trust.faq.noResults', { query: search }) ||
                            `No FAQ items found matching "${search}"`}
                    </Text>
                ) : (
                    <Accordion
                        type="single"
                        value={expanded}
                        onValueChange={handleAccordionChange}
                    >
                        {filteredFaqs.map(faq => (
                            <AccordionItem key={faq.id} value={faq.id}>
                                <AccordionTrigger>
                                    {faq.q}
                                </AccordionTrigger>
                                <AccordionContent>
                                    <Text className="font-sans text-body text-text-secondary">
                                        {faq.a}
                                    </Text>
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
