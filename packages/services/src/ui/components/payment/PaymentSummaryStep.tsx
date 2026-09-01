import type React from 'react';
import type { ComponentProps } from 'react';
import { useMemo } from 'react';
import { View, Text, Animated } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { Button } from '@oxyhq/bloom/button';
import { createPaymentStyles } from './paymentStyles';
import { getCurrencySymbol, CURRENCY_SYMBOLS } from './constants';
import type { PaymentItem, PaymentColors, PaymentStepAnimations } from './types';
import { useI18n } from '../../hooks/useI18n';

interface PaymentSummaryStepProps {
    paymentItems: PaymentItem[];
    amount: string | number;
    currency: string;
    description?: string;
    colors: PaymentColors;
    animations: PaymentStepAnimations;
    onClose: () => void;
    onNext: () => void;
}

type IoniconName = ComponentProps<typeof Ionicons>['name'];

const getItemTypeIcon = (type: string): IoniconName => {
    switch (type) {
        case 'product': return 'cart-outline';
        case 'subscription': return 'repeat-outline';
        case 'service': return 'construct-outline';
        case 'fee': return 'cash-outline';
        default: return 'pricetag-outline';
    }
};

const PaymentSummaryStep: React.FC<PaymentSummaryStepProps> = ({
    paymentItems,
    amount,
    currency,
    description,
    colors,
    animations,
    onClose,
    onNext,
}) => {
    const styles = useMemo(() => createPaymentStyles(colors), [colors]);
    const { t } = useI18n();
    const currencySymbol = getCurrencySymbol(currency);
    const { fadeAnim, slideAnim, scaleAnim } = animations;

    return (
        <Animated.View
            style={[
                styles.stepContainer,
                {
                    opacity: fadeAnim,
                    transform: [
                        { translateY: slideAnim },
                        { scale: scaleAnim },
                    ],
                },
            ]}
            accessibilityRole="none"
            accessibilityLabel="Payment summary step"
        >
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('payment.summary.title')}</Text>

                <View style={styles.summaryCard}>
                    <View style={styles.summaryCardContent}>
                        <Ionicons
                            name="receipt-outline"
                            size={64}
                            color={colors.primary}
                            style={styles.summaryCardIcon}
                        />
                        <Text style={styles.summaryCardMainTitle}>
                            {paymentItems.length > 0 ? t('payment.summary.orderSummary') : t('payment.summary.payment')}
                        </Text>
                        <Text style={styles.summaryCardSubtitle}>
                            {paymentItems.length > 0 ? t('payment.summary.reviewDetails') : t('payment.summary.completePayment')}
                        </Text>

                        {paymentItems.length > 0 ? (
                            <>
                                <View style={styles.summaryCardItems}>
                                    <SettingsListGroup>
                                        {paymentItems.map((item, idx) => (
                                            <SettingsListItem
                                                key={`item-${idx}`}
                                                icon={<Ionicons name={getItemTypeIcon(item.type)} size={20} color={colors.primary} />}
                                                title={`${item.type === 'product' && item.quantity ? `${item.quantity} \u00d7 ` : ''}${item.name}${item.type === 'subscription' && item.period ? ` (${item.period})` : ''}`}
                                                description={item.description || `${item.currency ? (CURRENCY_SYMBOLS[item.currency.toUpperCase()] || item.currency) : currencySymbol} ${item.price * (item.quantity ?? 1)}`}
                                                showChevron={false}
                                                rightElement={
                                                    <Text style={styles.summaryItemPrice}>
                                                        {item.currency ? (CURRENCY_SYMBOLS[item.currency.toUpperCase()] || item.currency) : currencySymbol} {item.price * (item.quantity ?? 1)}
                                                    </Text>
                                                }
                                            />
                                        ))}
                                    </SettingsListGroup>
                                </View>

                                <View style={styles.summaryCardDivider} />

                                <View style={styles.summaryCardTotalSection}>
                                    <View style={styles.summaryCardTotalRow}>
                                        <Text style={styles.summaryCardTotalLabel}>{t('payment.summary.subtotal')}</Text>
                                        <Text style={styles.summaryCardTotalValue}>{currencySymbol} {amount}</Text>
                                    </View>
                                    <View style={styles.summaryCardTotalRow}>
                                        <Text style={styles.summaryCardTotalLabel}>{t('payment.summary.tax')}</Text>
                                        <Text style={styles.summaryCardTotalValue}>{currencySymbol} 0.00</Text>
                                    </View>
                                    <View style={styles.summaryCardTotalRow}>
                                        <Text style={styles.summaryCardTotalLabel}>{t('payment.summary.total')}</Text>
                                        <Text style={styles.summaryCardTotalValue}>{currencySymbol} {amount}</Text>
                                    </View>
                                </View>
                            </>
                        ) : (
                            <>
                                <View style={styles.summaryCardAmount}>
                                    <Text style={styles.summaryCardAmountLabel}>{t('payment.summary.amountToPay')}</Text>
                                    <Text style={styles.summaryCardAmountValue}>{currencySymbol} {amount}</Text>
                                    {description && (
                                        <Text style={styles.summaryCardAmountDescription}>{description}</Text>
                                    )}
                                </View>

                                <View style={styles.summaryCardDivider} />

                                <View style={styles.summaryCardTotalSection}>
                                    <View style={styles.summaryCardTotalRow}>
                                        <Text style={styles.summaryCardTotalLabel}>{t('payment.summary.total')}</Text>
                                        <Text style={styles.summaryCardTotalValue}>{currencySymbol} {amount}</Text>
                                    </View>
                                </View>
                            </>
                        )}
                    </View>
                </View>
            </View>

            <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="secondary" onPress={onClose} size="small" icon={<Ionicons name="close" size={16} />}>
                    {t('payment.actions.close')}
                </Button>
                <Button variant="primary" onPress={onNext} size="small" icon={<Ionicons name="arrow-forward" size={16} />} iconPosition="right">
                    {t('payment.actions.continue')}
                </Button>
            </View>
        </Animated.View>
    );
};

export default PaymentSummaryStep;
