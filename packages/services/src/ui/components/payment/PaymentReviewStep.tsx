import type React from 'react';
import { useMemo } from 'react';
import { View, Text, Animated, ActivityIndicator } from 'react-native';
import Ionicons from '../../icons/Ionicons';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { Button } from '@oxyhq/bloom/button';
import { createPaymentStyles } from './paymentStyles';
import { PAYMENT_METHODS, getCurrencySymbol } from './constants';
import type { CardDetails, PaymentColors, PaymentStepAnimations } from './types';
import { useI18n } from '../../hooks/useI18n';

interface PaymentReviewStepProps {
    amount: string | number;
    currency: string;
    paymentMethod: string;
    cardDetails: CardDetails;
    colors: PaymentColors;
    animations: PaymentStepAnimations;
    isPaying: boolean;
    onBack: () => void;
    onPay: () => void;
}

const PaymentReviewStep: React.FC<PaymentReviewStepProps> = ({
    amount,
    currency,
    paymentMethod,
    cardDetails,
    colors,
    animations,
    isPaying,
    onBack,
    onPay,
}) => {
    const styles = useMemo(() => createPaymentStyles(colors), [colors]);
    const { t } = useI18n();
    const currencySymbol = getCurrencySymbol(currency);
    const { fadeAnim, slideAnim, scaleAnim } = animations;

    const selectedMethod = PAYMENT_METHODS.find(m => m.key === paymentMethod);

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
            accessibilityLabel="Review payment step"
        >
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('payment.review.title')}</Text>

                <SettingsListGroup>
                    <SettingsListItem
                        icon={<Ionicons name="shield-checkmark" size={20} color={colors.success} />}
                        title={t('payment.review.securePayment')}
                        description={t('payment.review.securePaymentDesc')}
                        showChevron={false}
                    />
                    <SettingsListItem
                        icon={<Ionicons name="cash-outline" size={20} color={colors.primary} />}
                        title={t('payment.review.amount')}
                        description={`${currencySymbol} ${amount}`}
                        showChevron={false}
                    />
                    <SettingsListItem
                        icon={selectedMethod ? <Ionicons name={selectedMethod.icon} size={20} color={colors.primary} /> : undefined}
                        title={t('payment.review.paymentMethod')}
                        description={selectedMethod ? t(`payment.methods.${selectedMethod.key}.label`) : undefined}
                        showChevron={false}
                    />
                    {paymentMethod === 'card' ? (
                        <SettingsListItem
                            icon={<Ionicons name="card-outline" size={20} color={colors.primary} />}
                            title={t('payment.review.card')}
                            description={cardDetails.number.replace(/.(?=.{4})/g, '*')}
                            showChevron={false}
                        />
                    ) : null}
                    {paymentMethod === 'oxy' ? (
                        <SettingsListItem
                            icon={<Ionicons name="wallet-outline" size={20} color={colors.primary} />}
                            title={t('payment.review.oxyPayAccount')}
                            description={t('payment.details.balance', { balance: '⊜ 123.45' })}
                            showChevron={false}
                        />
                    ) : null}
                    {paymentMethod === 'faircoin' ? (
                        <SettingsListItem
                            icon={<Ionicons name="qr-code-outline" size={20} color={colors.primary} />}
                            title={t('payment.review.faircoinWallet')}
                            description={t('payment.review.paidViaQR')}
                            showChevron={false}
                        />
                    ) : null}
                </SettingsListGroup>
            </View>

            <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="secondary" onPress={onBack} size="small" disabled={isPaying} icon={<Ionicons name="arrow-back" size={16} />}>
                    {t('payment.actions.back')}
                </Button>
                <Button
                    variant="primary"
                    onPress={onPay}
                    size="small"
                    disabled={isPaying}
                    icon={isPaying ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Ionicons name="checkmark" size={16} />}
                    iconPosition="right"
                >
                    {isPaying ? t('payment.review.processing') : t('payment.review.payNow')}
                </Button>
            </View>
        </Animated.View>
    );
};

export default PaymentReviewStep;
