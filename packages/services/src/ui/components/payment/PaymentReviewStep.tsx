import type React from 'react';
import { useMemo } from 'react';
import { View, Animated } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import Ionicons from '../../icons/Ionicons';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Button } from '@oxy.so/bloom/button';
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

  const selectedMethod = PAYMENT_METHODS.find((m) => m.key === paymentMethod);

  return (
    <Animated.View
      style={[
        styles.stepContainer,
        {
          opacity: fadeAnim,
          transform: [{ translateY: slideAnim }, { scale: scaleAnim }],
        },
      ]}
      accessibilityRole="none"
      accessibilityLabel="Review payment step"
    >
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('payment.review.title')}</Text>

        <GroupedSection>
          <GroupedSectionItem
            icon={<Ionicons name="shield-checkmark" size={20} color={colors.success} />}
            title={t('payment.review.securePayment')}
            description={t('payment.review.securePaymentDesc')}
            showChevron={false}
          />
          <GroupedSectionItem
            icon={<Ionicons name="cash-outline" size={20} color={colors.primary} />}
            title={t('payment.review.amount')}
            description={`${currencySymbol} ${amount}`}
            showChevron={false}
          />
          <GroupedSectionItem
            icon={
              selectedMethod ? (
                <Ionicons name={selectedMethod.icon} size={20} color={colors.primary} />
              ) : undefined
            }
            title={t('payment.review.paymentMethod')}
            description={
              selectedMethod ? t(`payment.methods.${selectedMethod.key}.label`) : undefined
            }
            showChevron={false}
          />
          {paymentMethod === 'card' ? (
            <GroupedSectionItem
              icon={<Ionicons name="card-outline" size={20} color={colors.primary} />}
              title={t('payment.review.card')}
              description={cardDetails.number.replace(/.(?=.{4})/g, '*')}
              showChevron={false}
            />
          ) : null}
          {paymentMethod === 'oxy' ? (
            <GroupedSectionItem
              icon={<Ionicons name="wallet-outline" size={20} color={colors.primary} />}
              title={t('payment.review.peableAccount')}
              description={t('payment.details.balance', { balance: '⊜ 123.45' })}
              showChevron={false}
            />
          ) : null}
          {paymentMethod === 'faircoin' ? (
            <GroupedSectionItem
              icon={<Ionicons name="qr-code-outline" size={20} color={colors.primary} />}
              title={t('payment.review.faircoinWallet')}
              description={t('payment.review.paidViaQR')}
              showChevron={false}
            />
          ) : null}
        </GroupedSection>
      </View>

      <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
        <Button
          appearance="subtle"
          tone="neutral"
          onPress={onBack}
          size="sm"
          disabled={isPaying}
          icon={<Ionicons name="arrow-back" size={16} />}
        >
          {t('payment.actions.back')}
        </Button>
        <Button
          appearance="solid"
          tone="accent"
          onPress={onPay}
          size="sm"
          disabled={isPaying}
          loading={isPaying}
          icon={<Ionicons name="checkmark" size={16} />}
          iconPosition="right"
        >
          {isPaying ? t('payment.review.processing') : t('payment.review.payNow')}
        </Button>
      </View>
    </Animated.View>
  );
};

export default PaymentReviewStep;
