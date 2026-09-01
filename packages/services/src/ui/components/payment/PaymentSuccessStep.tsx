import type React from 'react';
import { useMemo } from 'react';
import { View, Text, Animated } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Button } from '@oxyhq/bloom/button';
import { createPaymentStyles } from './paymentStyles';
import type { PaymentColors, PaymentStepAnimations } from './types';
import { useI18n } from '../../hooks/useI18n';

interface PaymentSuccessStepProps {
    colors: PaymentColors;
    animations: PaymentStepAnimations;
    onDone: () => void;
}

const PaymentSuccessStep: React.FC<PaymentSuccessStepProps> = ({
    colors,
    animations,
    onDone,
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
            accessibilityLabel="Payment complete"
        >
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('payment.success.title')}</Text>

                <View style={styles.successCard}>
                    <View style={styles.successContent}>
                        <Ionicons
                            name="checkmark-circle"
                            size={64}
                            color={colors.success}
                            style={styles.successIcon}
                        />
                        <Text style={styles.successMainTitle}>{t('payment.success.heading')}</Text>
                        <Text style={styles.successSubtitle}>{t('payment.success.thanks')}</Text>
                        <View style={{ height: 18 }} />
                        <Text style={styles.successMessage}>{t('payment.success.processed')}</Text>
                    </View>
                </View>
            </View>

            <Button variant="primary" onPress={onDone} size="small" icon={<Ionicons name="checkmark" size={16} />} iconPosition="right">
                {t('payment.actions.done')}
            </Button>
        </Animated.View>
    );
};

export default PaymentSuccessStep;
