import type React from 'react';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import Ionicons from '../icons/Ionicons';
import { toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { Search } from '@oxyhq/bloom/search';
import { Button } from '@oxyhq/bloom/button';
import {
    Accordion,
    AccordionItem,
    AccordionTrigger,
    AccordionContent,
} from '@oxyhq/bloom/accordion';
import { Text } from '@oxyhq/bloom/typography';
import type { BaseScreenProps } from '../types/navigation';
import { Loading } from '@oxyhq/bloom/loading';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useOxy } from '../context/OxyContext';

interface FAQ {
    id: string;
    question: string;
    answer: string;
    category: string;
}

const FAQScreen: React.FC<BaseScreenProps> = ({
    onClose,
    goBack,
}) => {
    const { oxyServices } = useOxy();
    const { t } = useI18n();

    useSurfaceHeader({ title: t('faq.title') || 'FAQ' });
    const bloomTheme = useTheme();

    const [faqs, setFaqs] = useState<FAQ[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedIds, setExpandedIds] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

    // Load FAQs from API
    useEffect(() => {
        const loadFAQs = async () => {
            try {
                setIsLoading(true);
                const data = await oxyServices.getFAQs();
                setFaqs(data);
            } catch {
                toast.error(t('faq.loadError') || 'Failed to load FAQs');
            } finally {
                setIsLoading(false);
            }
        };

        loadFAQs();
    }, [oxyServices, t]);

    // Get unique categories
    const categories = useMemo(() => {
        const cats = [...new Set(faqs.map(f => f.category))];
        return cats.sort();
    }, [faqs]);

    // Filter FAQs based on search and category
    const filteredFaqs = useMemo(() => {
        let result = faqs;

        if (selectedCategory) {
            result = result.filter(f => f.category === selectedCategory);
        }

        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            result = result.filter(f =>
                f.question.toLowerCase().includes(query) ||
                f.answer.toLowerCase().includes(query)
            );
        }

        return result;
    }, [faqs, searchQuery, selectedCategory]);

    const handleAccordionChange = useCallback(
        (value: string | string[] | undefined) => {
            if (Array.isArray(value)) {
                setExpandedIds(value);
            } else if (value == null) {
                setExpandedIds([]);
            } else {
                setExpandedIds([value]);
            }
        },
        [],
    );

    return (
        <>

            {/* Search bar */}
            <View className="px-screen-margin py-space-12">
                <Search
                    label={t('faq.searchPlaceholder') || 'Search FAQs...'}
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    onClearText={() => setSearchQuery('')}
                    accessibilityLabel="Search FAQs"
                />
            </View>

            {/* Category filters */}
            {categories.length > 0 && (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.categoriesScroll}
                    contentContainerClassName="px-screen-margin gap-space-8"
                >
                    <Button
                        variant={!selectedCategory ? 'primary' : 'secondary'}
                        size="small"
                        onPress={() => setSelectedCategory(null)}
                        accessibilityLabel="Show all categories"
                        accessibilityHint="Filter to show all FAQ categories"
                    >
                        {t('faq.allCategories') || 'All'}
                    </Button>
                    {categories.map(cat => (
                        <Button
                            key={cat}
                            variant={selectedCategory === cat ? 'primary' : 'secondary'}
                            size="small"
                            onPress={() => setSelectedCategory(cat)}
                            accessibilityLabel={`Filter by ${cat}`}
                            accessibilityHint={`Show FAQs in the ${cat} category`}
                        >
                            {cat}
                        </Button>
                    ))}
                </ScrollView>
            )}

            <View className="px-screen-margin">
                {isLoading ? (
                    <Loading
                        size="large"
                        color={bloomTheme.colors.text}
                        text={t('faq.loading') || 'Loading FAQs...'}
                    />
                ) : filteredFaqs.length === 0 ? (
                    <Text className="text-text-secondary text-center p-space-40">
                        {searchQuery ? (t('faq.noResults') || 'No FAQs match your search') : (t('faq.empty') || 'No FAQs available')}
                    </Text>
                ) : (
                    <Accordion
                        type="multiple"
                        value={expandedIds}
                        onValueChange={handleAccordionChange}
                    >
                        {filteredFaqs.map(faq => (
                            <AccordionItem key={faq.id} value={faq.id}>
                                <AccordionTrigger>
                                    {faq.question}
                                </AccordionTrigger>
                                <AccordionContent>
                                    <Text className="font-sans text-bodyMedium text-text-secondary">
                                        {faq.answer}
                                    </Text>
                                    <View className="flex-row items-center mt-space-12 gap-space-4">
                                        <Ionicons
                                            name="pricetag-outline"
                                            size={14}
                                            color={bloomTheme.colors.primary}
                                        />
                                        <Text className="font-sans text-caption text-primary">
                                            {faq.category}
                                        </Text>
                                    </View>
                                </AccordionContent>
                            </AccordionItem>
                        ))}
                    </Accordion>
                )}
            </View>
        </>
    );
};

// Measured layout only (no color): cap the horizontal category row height so
// the filter pills do not stretch the scroll viewport vertically.
const styles = StyleSheet.create({
    categoriesScroll: {
        maxHeight: 50,
    },
});

export default FAQScreen;
