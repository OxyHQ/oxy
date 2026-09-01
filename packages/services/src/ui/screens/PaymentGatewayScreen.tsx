import type React from 'react';
import { useState, useRef, useMemo, useCallback } from 'react';
import {
    View,
    Animated,
    Platform,
    useWindowDimensions,
} from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { Button } from '@oxyhq/bloom/button';
import { useTheme } from '@oxyhq/bloom/theme';
import { H4 } from '@oxyhq/bloom/typography';
import Ionicons from '../icons/Ionicons';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import QRCode from 'react-native-qrcode-svg';

import PaymentSummaryStep from '../components/payment/PaymentSummaryStep';
import PaymentMethodStep from '../components/payment/PaymentMethodStep';
import PaymentDetailsStep from '../components/payment/PaymentDetailsStep';
import PaymentReviewStep from '../components/payment/PaymentReviewStep';
import PaymentSuccessStep from '../components/payment/PaymentSuccessStep';
import { PAYMENT_METHODS } from '../components/payment/constants';
import type { PaymentItem, PaymentGatewayResult, CardDetails } from '../components/payment/types';

export type { PaymentItem, PaymentGatewayResult };

interface PaymentGatewayScreenProps extends BaseScreenProps {
    onPaymentResult?: (result: PaymentGatewayResult) => void;
    amount: string | number;
    currency?: string;
    onClose?: () => void;
    paymentItems?: PaymentItem[];
    description?: string;
}

const getUniqueItemTypes = (items: PaymentItem[]) => {
    const types = items.map(item => item.type);
    return Array.from(new Set(types));
};

const PaymentGatewayScreen: React.FC<PaymentGatewayScreenProps> = (props) => {
    const {
        navigate,
        goBack,
        onPaymentResult,
        amount,
        currency = 'FAIR',
        onClose,
        paymentItems = [],
        description = '',
    } = props;

    // DEV ENFORCEMENT: Only allow one type of payment item
    if (process.env.NODE_ENV !== 'production' && paymentItems.length > 0) {
        const uniqueTypes = getUniqueItemTypes(paymentItems);
        if (uniqueTypes.length > 1) {
            throw new Error(
                `PaymentGatewayScreen: paymentItems contains mixed types (${uniqueTypes.join(', ')}). Only one type is allowed per payment.`
            );
        }
    }

    // Step states
    const [currentStep, setCurrentStep] = useState(0);
    const [paymentMethod, setPaymentMethod] = useState('card');
    const [cardDetails, setCardDetails] = useState<CardDetails>({ number: '', expiry: '', cvv: '' });
    const [isPaying, setIsPaying] = useState(false);

    // Animations
    const fadeAnim = useRef(new Animated.Value(1)).current;
    const slideAnim = useRef(new Animated.Value(0)).current;
    const scaleAnim = useRef(new Animated.Value(1)).current;
    const progressAnim = useRef(new Animated.Value(0.2)).current;

    // Bloom theme drives all payment colors — the wizard step components consume
    // `colors` (PaymentColors === bloom ThemeColors) directly, no mapper.
    const bloomTheme = useTheme();
    const colors = bloomTheme.colors;
    const { t } = useI18n();

    // Determine if the payment is for a recurring item (subscription)
    const isRecurring = paymentItems.length > 0 && paymentItems[0].type === 'subscription';

    // Filter payment methods: remove 'faircoin' if recurring
    const availablePaymentMethods = useMemo(() => {
        if (isRecurring) {
            return PAYMENT_METHODS.filter(m => m.key !== 'faircoin');
        }
        return PAYMENT_METHODS;
    }, [isRecurring]);

    // Animation transitions
    const animateTransition = useCallback((nextStep: number) => {
        Animated.timing(scaleAnim, {
            toValue: 0.95,
            duration: 150,
            useNativeDriver: Platform.OS !== 'web',
        }).start();
        Animated.timing(fadeAnim, {
            toValue: 0,
            duration: 200,
            useNativeDriver: Platform.OS !== 'web',
        }).start(() => {
            setCurrentStep(nextStep);
            slideAnim.setValue(-50);
            scaleAnim.setValue(0.95);
            Animated.parallel([
                Animated.timing(fadeAnim, {
                    toValue: 1,
                    duration: 300,
                    useNativeDriver: Platform.OS !== 'web',
                }),
                Animated.spring(slideAnim, {
                    toValue: 0,
                    tension: 80,
                    friction: 8,
                    useNativeDriver: Platform.OS !== 'web',
                }),
                Animated.spring(scaleAnim, {
                    toValue: 1,
                    tension: 80,
                    friction: 8,
                    useNativeDriver: Platform.OS !== 'web',
                })
            ]).start();
        });
    }, [fadeAnim, slideAnim, scaleAnim]);

    const nextStep = useCallback(() => {
        if (currentStep < 4) {
            Animated.timing(progressAnim, {
                toValue: (currentStep + 2) / 5,
                duration: 300,
                useNativeDriver: false,
            }).start();
            animateTransition(currentStep + 1);
        }
    }, [currentStep, progressAnim, animateTransition]);

    const prevStep = useCallback(() => {
        if (currentStep > 0) {
            Animated.timing(progressAnim, {
                toValue: (currentStep) / 5,
                duration: 300,
                useNativeDriver: false,
            }).start();
            animateTransition(currentStep - 1);
        }
    }, [currentStep, progressAnim, animateTransition]);

    // Pay handler — placeholder for payment integration
    const handlePay = useCallback(() => {
        setIsPaying(true);
        setTimeout(() => {
            setIsPaying(false);
            nextStep();
        }, 1500);
    }, [nextStep]);

    const handleDone = useCallback(() => {
        if (onPaymentResult) {
            onPaymentResult({ success: true });
        }
        navigate?.('ManageAccount');
    }, [onPaymentResult, navigate]);

    const handleClose = useCallback(() => {
        if (onPaymentResult) {
            onPaymentResult({ success: false, error: 'cancelled' });
        }
        if (onClose) {
            onClose();
        } else if (goBack) {
            goBack();
        }
    }, [onPaymentResult, onClose, goBack]);

    // Shared Dialog nav header: a stable "Payment" title + a back affordance that
    // steps the wizard back once past the first step (the step components keep
    // their own bottom Back/Continue CTAs; the header's close dismisses, matching
    // the pre-existing backdrop-dismiss).
    useSurfaceHeader({
        title: t('payment.title'),
        largeTitle: false,
        onBack: currentStep > 0 ? prevStep : undefined,
    });

    // Validate amount
    if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
        return (
            <View className="items-center justify-center px-screen-margin gap-space-24 py-space-40">
                <Ionicons name="alert-circle-outline" size={48} color={bloomTheme.colors.error} />
                <H4 className="text-text text-center">
                    {t('payment.errors.invalidAmount')}
                </H4>
                <Button
                    variant="primary"
                    onPress={handleClose}
                    size="small"
                    icon={<Ionicons name="close" size={16} />}
                    iconPosition="right"
                >
                    {t('payment.actions.close')}
                </Button>
            </View>
        );
    }

    // FairCoin address placeholder — replaced when integration is wired up.
    const faircoinAddress = 'f1abc1234FAIRCOINADDRESS';
    const { width: windowWidth } = useWindowDimensions();
    const isMobile = windowWidth < 600;
    const qrSize = !isMobile
        ? Math.min(windowWidth * 0.3, 220)
        : Math.min(windowWidth * 0.8, 300);

    const animations = { fadeAnim, slideAnim, scaleAnim };

    const renderCurrentStep = () => {
        switch (currentStep) {
            case 0:
                return (
                    <PaymentSummaryStep
                        paymentItems={paymentItems}
                        amount={amount}
                        currency={currency}
                        description={description}
                        colors={colors}
                        animations={animations}
                        onClose={handleClose}
                        onNext={nextStep}
                    />
                );
            case 1:
                return (
                    <PaymentMethodStep
                        availablePaymentMethods={availablePaymentMethods}
                        selectedMethod={paymentMethod}
                        onSelectMethod={setPaymentMethod}
                        colors={colors}
                        animations={animations}
                        onBack={prevStep}
                        onNext={nextStep}
                    />
                );
            case 2:
                return (
                    <PaymentDetailsStep
                        paymentMethod={paymentMethod}
                        cardDetails={cardDetails}
                        onCardDetailsChange={setCardDetails}
                        colors={colors}
                        animations={animations}
                        faircoinAddress={faircoinAddress}
                        isMobile={isMobile}
                        qrSize={qrSize}
                        onBack={prevStep}
                        onNext={nextStep}
                        QRCodeComponent={QRCode}
                    />
                );
            case 3:
                return (
                    <PaymentReviewStep
                        amount={amount}
                        currency={currency}
                        paymentMethod={paymentMethod}
                        cardDetails={cardDetails}
                        colors={colors}
                        animations={animations}
                        isPaying={isPaying}
                        onBack={prevStep}
                        onPay={handlePay}
                    />
                );
            case 4:
                return (
                    <PaymentSuccessStep
                        colors={colors}
                        animations={animations}
                        onDone={handleDone}
                    />
                );
            default:
                return null;
        }
    };

    return (
        <View className="p-space-16">
            {renderCurrentStep()}
        </View>
    );
};

export default PaymentGatewayScreen;
