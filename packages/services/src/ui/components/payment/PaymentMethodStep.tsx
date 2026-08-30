import type React from 'react';
import { useMemo } from 'react';
import { View, Text, Animated } from 'react-native';
import Ionicons from '../../icons/Ionicons';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { Button } from '@oxyhq/bloom/button';
import FAIRWalletIcon from '../icon/FAIRWalletIcon';
import { createPaymentStyles } from './paymentStyles';
import type { PaymentMethod, PaymentColors, PaymentStepAnimations } from './types';
import { useI18n } from '../../hooks/useI18n';

interface PaymentMethodStepProps {
    availablePaymentMethods: PaymentMethod[];
    selectedMethod: string;
    onSelectMethod: (method: string) => void;
    colors: PaymentColors;
    animations: PaymentStepAnimations;
    onBack: () => void;
    onNext: () => void;
}

const PaymentMethodStep: React.FC<PaymentMethodStepProps> = ({
    availablePaymentMethods,
    selectedMethod,
    onSelectMethod,
    colors,
    animations,
    onBack,
    onNext,
}) => {
    const styles = useMemo(() => createPaymentStyles(colors), [colors]);
    const { t } = useI18n();
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
            accessibilityLabel="Choose payment method step"
        >
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('payment.method.title')}</Text>

                <SettingsListGroup>
                    {availablePaymentMethods.map(method => {
                        const iconColor = method.key === 'card' ? '#007AFF' :
                            method.key === 'oxy' ? '#32D74B' :
                                method.key === 'faircoin' ? '#9ffb50' : colors.primary;
                        const iconElement = method.key === 'faircoin'
                            ? <FAIRWalletIcon size={20} />
                            : <Ionicons name={method.icon} size={20} color={iconColor} />;
                        return (
                            <SettingsListItem
                                key={method.key}
                                icon={iconElement}
                                title={t(`payment.methods.${method.key}.label`)}
                                description={t(`payment.methods.${method.key}.description`)}
                                onPress={() => onSelectMethod(method.key)}
                                showChevron={false}
                                rightElement={selectedMethod === method.key ? (
                                    <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
                                ) : undefined}
                            />
                        );
                    })}
                </SettingsListGroup>
            </View>

            <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="secondary" onPress={onBack} size="small" icon={<Ionicons name="arrow-back" size={16} />}>
                    {t('payment.actions.back')}
                </Button>
                <Button variant="primary" onPress={onNext} size="small" icon={<Ionicons name="arrow-forward" size={16} />} iconPosition="right">
                    {t('payment.actions.continue')}
                </Button>
            </View>
        </Animated.View>
    );
};

export default PaymentMethodStep;
