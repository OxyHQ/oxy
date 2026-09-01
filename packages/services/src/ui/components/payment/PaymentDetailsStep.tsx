import type React from 'react';
import { useMemo } from 'react';
import { View, Text, Animated, TouchableOpacity, Clipboard, Linking } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Button } from '@oxyhq/bloom/button';
import { TextField, TextFieldInput } from '@oxyhq/bloom/text-field';
import FAIRWalletIcon from '../icon/FAIRWalletIcon';
import { createPaymentStyles } from './paymentStyles';
import { toast } from '@oxyhq/bloom';
import type { CardDetails, PaymentColors, PaymentStepAnimations } from './types';
import { useI18n } from '../../hooks/useI18n';

interface PaymentDetailsStepProps {
    paymentMethod: string;
    cardDetails: CardDetails;
    onCardDetailsChange: (details: CardDetails) => void;
    colors: PaymentColors;
    animations: PaymentStepAnimations;
    faircoinAddress: string;
    isMobile: boolean;
    qrSize: number;
    onBack: () => void;
    onNext: () => void;
    QRCodeComponent?: React.ComponentType<{ value?: string; size?: number }>;
}

const PaymentDetailsStep: React.FC<PaymentDetailsStepProps> = ({
    paymentMethod,
    cardDetails,
    onCardDetailsChange,
    colors,
    animations,
    faircoinAddress,
    isMobile,
    qrSize,
    onBack,
    onNext,
    QRCodeComponent,
}) => {
    const styles = useMemo(() => createPaymentStyles(colors), [colors]);
    const { t } = useI18n();
    const { fadeAnim, slideAnim, scaleAnim } = animations;

    const handleCopyAddress = () => {
        Clipboard.setString(faircoinAddress);
        toast(t('payment.details.addressCopied'));
    };

    const handleOpenFairWallet = () => {
        const url = `fairwallet://pay?address=${faircoinAddress}`;
        Linking.openURL(url);
    };

    const isCardValid = cardDetails.number && cardDetails.expiry && cardDetails.cvv;

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
            accessibilityLabel="Enter payment details step"
        >
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>
                    {paymentMethod === 'card' ? t('payment.details.cardDetails') :
                        paymentMethod === 'oxy' ? t('payment.details.oxyPay') :
                            paymentMethod === 'faircoin' ? t('payment.details.faircoinPayment') : t('payment.details.paymentDetails')}
                </Text>

                {paymentMethod === 'card' && (
                    <View style={styles.cardPaymentCard}>
                        <View style={styles.cardPaymentContent}>
                            <Ionicons name="card-outline" size={64} color={colors.primary} style={styles.cardPaymentIcon} />
                            <Text style={styles.cardPaymentMainTitle}>{t('payment.details.creditCard')}</Text>
                            <Text style={styles.cardPaymentSubtitle}>{t('payment.details.enterCardSecurely')}</Text>

                            <View style={styles.cardPaymentFields}>
                                <View style={styles.cardRowInfo}>
                                    <Ionicons name="card-outline" size={24} color={colors.primary} style={styles.cardRowIcon} />
                                    <Text style={styles.cardRowText}>{t('payment.details.acceptedCards')}</Text>
                                </View>
                                <TextField>
                                    <TextFieldInput
                                        floatingLabel
                                        label={t('payment.details.cardNumber')}
                                        value={cardDetails.number}
                                        onChangeText={text => {
                                            const formatted = text.replace(/\s/g, '').replace(/(\d{4})/g, '$1 ').trim();
                                            onCardDetailsChange({ ...cardDetails, number: formatted });
                                        }}
                                        placeholder="1234 5678 9012 3456"
                                        keyboardType="numeric"
                                        maxLength={19}
                                        accessibilityLabel="Card number"
                                        accessibilityHint="Enter your 16-digit card number"
                                    />
                                </TextField>
                                <View style={styles.cardFieldRow}>
                                    <View style={styles.cardFieldHalfLeft}>
                                        <TextField>
                                            <TextFieldInput
                                                floatingLabel
                                                label={t('payment.details.expiry')}
                                                value={cardDetails.expiry}
                                                onChangeText={text => {
                                                    const formatted = text.replace(/\D/g, '').replace(/(\d{2})(\d)/, '$1/$2');
                                                    onCardDetailsChange({ ...cardDetails, expiry: formatted });
                                                }}
                                                placeholder="MM/YY"
                                                maxLength={5}
                                                accessibilityLabel="Expiry date"
                                                accessibilityHint="Enter expiry date in MM/YY format"
                                            />
                                        </TextField>
                                    </View>
                                    <View style={styles.cardFieldHalfRight}>
                                        <TextField>
                                            <TextFieldInput
                                                floatingLabel
                                                label="CVV"
                                                value={cardDetails.cvv}
                                                onChangeText={text => {
                                                    const formatted = text.replace(/\D/g, '');
                                                    onCardDetailsChange({ ...cardDetails, cvv: formatted });
                                                }}
                                                placeholder="123"
                                                keyboardType="numeric"
                                                maxLength={4}
                                                accessibilityLabel="CVV"
                                                accessibilityHint="Enter 3 or 4 digit security code"
                                            />
                                        </TextField>
                                    </View>
                                </View>
                            </View>

                            <View style={{ height: 18 }} />
                            <Text style={styles.cardPaymentWaiting}>{t('payment.details.readyToProcess')}</Text>
                        </View>
                    </View>
                )}

                {paymentMethod === 'oxy' && (
                    <View style={styles.oxyPayCard}>
                        <View style={styles.oxyPayContent}>
                            <Ionicons name="wallet-outline" size={64} color={colors.primary} style={styles.oxyPayIcon} />
                            <Text style={styles.oxyPayMainTitle}>{t('payment.details.oxyPay')}</Text>
                            <Text style={styles.oxyPaySubtitle}>{t('payment.details.payWithWallet')}</Text>
                            <View style={styles.oxyPayBalanceBox}>
                                <Text style={styles.oxyPayBalanceText}>{t('payment.details.balance', { balance: '⊜ 123.45' })}</Text>
                            </View>
                            <View style={{ height: 18 }} />
                            <Text style={styles.oxyPayWaiting}>{t('payment.details.readyToProcess')}</Text>
                        </View>
                    </View>
                )}

                {paymentMethod === 'faircoin' && (
                    <View style={styles.faircoinCard}>
                        <View style={styles.faircoinContent}>
                            <FAIRWalletIcon size={64} style={styles.faircoinIcon} />
                            <Text style={styles.faircoinMainTitle}>FAIRWallet</Text>
                            <Text style={styles.faircoinSubtitle}>{t('payment.details.payWithFairCoin')}</Text>
                            {!isMobile && QRCodeComponent ? (
                                <>
                                    <Text style={styles.faircoinScanText}>{t('payment.details.scanToPay')}</Text>
                                    <View style={styles.faircoinQRCard}>
                                        <QRCodeComponent value={faircoinAddress} size={qrSize - 32} />
                                        <View style={styles.faircoinQRBadge}>
                                            <FAIRWalletIcon size={28} />
                                        </View>
                                    </View>
                                </>
                            ) : (
                                <>
                                    <Text style={styles.faircoinTitle}>{t('payment.details.fairWalletInstructions')}</Text>
                                    <Text style={styles.faircoinAddress}>{faircoinAddress}</Text>
                                    <TouchableOpacity
                                        style={[styles.faircoinButton, { backgroundColor: '#9ffb50', borderRadius: 18, marginTop: 12, width: '90%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }]}
                                        onPress={handleOpenFairWallet}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('payment.details.openInFairWallet')}
                                    >
                                        <FAIRWalletIcon size={20} style={{ marginRight: 8 }} />
                                        <Text style={[styles.faircoinButtonText, { color: '#1b1f0a', fontWeight: 'bold', fontSize: 16 }]}>{t('payment.details.openInFairWallet')}</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        style={[styles.faircoinButton, { backgroundColor: '#9ffb50', borderRadius: 18, marginTop: 10, width: '90%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }]}
                                        onPress={handleCopyAddress}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('payment.details.copyAddress')}
                                    >
                                        <FAIRWalletIcon size={20} style={{ marginRight: 8 }} />
                                        <Text style={[styles.faircoinButtonText, { color: '#1b1f0a', fontWeight: 'bold', fontSize: 16 }]}>{t('payment.details.copyAddress')}</Text>
                                    </TouchableOpacity>
                                </>
                            )}
                            <View style={{ height: 18 }} />
                            <Text style={styles.faircoinWaiting}>{t('payment.details.waitingForPayment')}</Text>
                        </View>
                    </View>
                )}
            </View>

            <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="secondary" onPress={onBack} size="small" icon={<Ionicons name="arrow-back" size={16} />}>
                    {t('payment.actions.back')}
                </Button>
                <Button
                    variant="primary"
                    onPress={onNext}
                    size="small"
                    icon={<Ionicons name="arrow-forward" size={16} />}
                    iconPosition="right"
                    disabled={paymentMethod === 'card' && !isCardValid}
                >
                    {t('payment.actions.continue')}
                </Button>
            </View>
        </Animated.View>
    );
};

export default PaymentDetailsStep;
