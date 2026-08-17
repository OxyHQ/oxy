import type React from 'react';
import { useState, useEffect, useCallback } from 'react';
import { View, ScrollView, ActivityIndicator } from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { toast } from '@oxyhq/bloom/toast';
import { surfaces } from '@oxyhq/bloom/surfaces';
import { useTheme } from '@oxyhq/bloom/theme';
import { Button } from '@oxyhq/bloom/button';
import { Chip } from '@oxyhq/bloom/chip';
import { Badge } from '@oxyhq/bloom/badge';
import { Card, CardBody } from '@oxyhq/bloom/card';
import { H2, H4, H5, Text } from '@oxyhq/bloom/typography';
import { BenefitList, BenefitRow } from '@oxyhq/bloom/benefit-list';
import {
    SegmentedControl,
    SegmentedControlItem,
    SegmentedControlItemText,
} from '@oxyhq/bloom/segmented-control';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useOxy } from '../context/OxyContext';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

interface SubscriptionPlan {
    id: string;
    name: string;
    description: string;
    price: number;
    currency: string;
    interval: 'month' | 'year';
    features: string[];
    appScope: 'ecosystem' | 'specific';
    applicableApps: string[]; // ['mention', 'oxy-social', 'oxy-workspace', 'oxy-creator'] etc.
    includedFeatures: string[]; // Feature IDs that are included in this plan
    isPopular?: boolean;
    isCurrentPlan?: boolean;
}

interface IndividualFeature {
    id: string;
    name: string;
    description: string;
    price: number;
    currency: string;
    interval: 'month' | 'year';
    category: 'analytics' | 'customization' | 'content' | 'networking' | 'productivity';
    appScope: 'ecosystem' | 'specific';
    applicableApps: string[]; // Apps where this feature is available
    canBePurchasedSeparately: boolean;
    includedInPlans: string[]; // Plan IDs that include this feature
    isSubscribed?: boolean;
    isIncludedInCurrentPlan?: boolean;
}

interface UserSubscription {
    id: string;
    planId: string;
    status: 'active' | 'canceled' | 'past_due' | 'trialing';
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    trialEnd?: string;
}

const TAB_PLANS = 'plans';
const TAB_FEATURES = 'features';
type ActiveTab = typeof TAB_PLANS | typeof TAB_FEATURES;

const BILLING_MONTH = 'month';
const BILLING_YEAR = 'year';
type BillingInterval = typeof BILLING_MONTH | typeof BILLING_YEAR;

/** Yearly billing discount applied when extrapolating a monthly price. */
const YEARLY_DISCOUNT = 0.8;
const MONTHS_PER_YEAR = 12;
/** Simulated payment latency for the mocked subscribe/feature flows (ms). */
const SUBSCRIBE_DELAY_MS = 2000;
const FEATURE_DELAY_MS = 1500;
/** One subscription period for the mocked renewal date (30 days, in ms). */
const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

const FEATURE_CATEGORIES: IndividualFeature['category'][] = [
    'analytics',
    'customization',
    'content',
    'networking',
    'productivity',
];

// Pure package-name → display-name mapping (module scope so the nav-header
// subtitle can reference it before the component's render helpers).
const getAppDisplayName = (packageName: string): string => {
    const appNames: Record<string, string> = {
        'mention': 'Mention',
        'oxy-social': 'Oxy Social',
        'oxy-workspace': 'Oxy Workspace',
        'oxy-creator': 'Oxy Creator',
        'oxy-analytics': 'Oxy Analytics',
        'oxy-studio': 'Oxy Studio',
    };
    return appNames[packageName] || packageName;
};

const PremiumSubscriptionScreen: React.FC<BaseScreenProps> = ({
    onClose,
    navigate,
    goBack,
}) => {
    // Premium state belongs to the ACTIVE account (the org/project/bot when
    // switched, else the personal user), not the device-session owner.
    const { user } = useOxy();
    const [loading, setLoading] = useState(true);
    const [subscription, setSubscription] = useState<UserSubscription | null>(null);
    const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
    const [individualFeatures, setIndividualFeatures] = useState<IndividualFeature[]>([]);
    const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
    const [processingPayment, setProcessingPayment] = useState(false);
    const [billingInterval, setBillingInterval] = useState<BillingInterval>(BILLING_MONTH);
    const [activeTab, setActiveTab] = useState<ActiveTab>(TAB_PLANS);
    const [currentAppPackage, setCurrentAppPackage] = useState<string>('mention'); // Default to mention for demo

    const { t } = useI18n();

    useSurfaceHeader({ title: t('premium.title') || 'Oxy+ Subscriptions', subtitle: t('premium.forApp', { app: getAppDisplayName(currentAppPackage) }) || `for ${getAppDisplayName(currentAppPackage)}` });
    const bloomTheme = useTheme();
    const colors = bloomTheme.colors;

    // Oxy+ subscription plans
    const mockPlans: SubscriptionPlan[] = [
        {
            id: 'mention-plus',
            name: 'Mention+',
            description: 'Enhanced features for better social experience',
            price: 4.99,
            currency: 'USD',
            interval: 'month',
            appScope: 'specific',
            applicableApps: ['mention'], // Only available in mention app
            features: [
                'Undo posts option',
                'Improved reading mode',
                'Organize bookmarks into folders',
                'Early access to select features',
                'Edit posts capability',
                'Enhanced customization options'
            ],
            includedFeatures: ['reading-mode-plus', 'custom-themes']
        },
        {
            id: 'oxy-insider',
            name: 'Oxy+ Insider',
            description: 'Exclusive access to behind-the-scenes content',
            price: 9.99,
            currency: 'USD',
            interval: 'month',
            appScope: 'ecosystem',
            applicableApps: ['mention', 'oxy-social', 'oxy-workspace', 'oxy-creator'],
            features: [
                'Everything in Mention+',
                'Behind-the-scenes updates from creators',
                'Early access to new features',
                'Dedicated support team',
                'Exclusive content access',
                'Beta feature testing'
            ],
            includedFeatures: ['reading-mode-plus', 'custom-themes', 'analytics-basic'],
            isPopular: true
        },
        {
            id: 'oxy-connect',
            name: 'Oxy+ Connect',
            description: 'Advanced networking and community features',
            price: 14.99,
            currency: 'USD',
            interval: 'month',
            appScope: 'ecosystem',
            applicableApps: ['mention', 'oxy-social', 'oxy-workspace', 'oxy-creator'],
            features: [
                'Everything in Oxy+ Insider',
                'Create and join private groups',
                'Advanced search and filtering tools',
                'Customizable profile highlighting',
                'Enhanced connection features',
                'Priority in community events'
            ],
            includedFeatures: ['reading-mode-plus', 'custom-themes', 'analytics-basic', 'group-management']
        },
        {
            id: 'oxy-premium',
            name: 'Oxy+ Premium',
            description: 'Complete premium experience with all perks',
            price: 24.99,
            currency: 'USD',
            interval: 'month',
            appScope: 'ecosystem',
            applicableApps: ['mention', 'oxy-social', 'oxy-workspace', 'oxy-creator', 'oxy-analytics'],
            features: [
                'Everything in Oxy+ Connect',
                'Priority customer support',
                'Access to premium content and events',
                'Advanced analytics dashboard',
                'VIP community status',
                'Exclusive premium events'
            ],
            includedFeatures: ['reading-mode-plus', 'custom-themes', 'analytics-basic', 'analytics-advanced', 'group-management']
        },
        {
            id: 'oxy-creator',
            name: 'Oxy+ Creator',
            description: 'Professional tools for content creators',
            price: 39.99,
            currency: 'USD',
            interval: 'month',
            appScope: 'ecosystem',
            applicableApps: ['mention', 'oxy-social', 'oxy-workspace', 'oxy-creator', 'oxy-analytics', 'oxy-studio'],
            features: [
                'Everything in Oxy+ Premium',
                'Advanced analytics and insights',
                'Promotional tools and resources',
                'Content monetization features',
                'Creator support program',
                'Revenue sharing opportunities'
            ],
            includedFeatures: ['reading-mode-plus', 'custom-themes', 'analytics-basic', 'analytics-advanced', 'group-management', 'creator-tools', 'monetization-features']
        }
    ];

    // Individual feature subscriptions
    const mockIndividualFeatures: IndividualFeature[] = [
        {
            id: 'analytics-basic',
            name: 'Basic Analytics',
            description: 'View post performance and engagement metrics',
            price: 2.99,
            currency: 'USD',
            interval: 'month',
            category: 'analytics',
            appScope: 'ecosystem',
            applicableApps: ['mention', 'oxy-social', 'oxy-workspace'],
            canBePurchasedSeparately: true,
            includedInPlans: ['oxy-insider', 'oxy-connect', 'oxy-premium', 'oxy-creator']
        },
        {
            id: 'analytics-advanced',
            name: 'Advanced Analytics',
            description: 'Detailed insights, trends, and audience demographics',
            price: 7.99,
            currency: 'USD',
            interval: 'month',
            category: 'analytics',
            appScope: 'ecosystem',
            applicableApps: ['mention', 'oxy-social', 'oxy-workspace', 'oxy-creator', 'oxy-analytics'],
            canBePurchasedSeparately: true,
            includedInPlans: ['oxy-premium', 'oxy-creator']
        },
        {
            id: 'custom-themes',
            name: 'Custom Themes',
            description: 'Personalize your app with custom colors and layouts',
            price: 1.99,
            currency: 'USD',
            interval: 'month',
            category: 'customization',
            appScope: 'ecosystem',
            applicableApps: ['mention', 'oxy-social', 'oxy-workspace', 'oxy-creator'],
            canBePurchasedSeparately: false, // Included in all plans
            includedInPlans: ['mention-plus', 'oxy-insider', 'oxy-connect', 'oxy-premium', 'oxy-creator']
        },
        {
            id: 'reading-mode-plus',
            name: 'Reading Mode Plus',
            description: 'Enhanced reading experience with focus modes',
            price: 1.99,
            currency: 'USD',
            interval: 'month',
            category: 'content',
            appScope: 'specific',
            applicableApps: ['mention', 'oxy-social'],
            canBePurchasedSeparately: false, // Included in all plans
            includedInPlans: ['mention-plus', 'oxy-insider', 'oxy-connect', 'oxy-premium', 'oxy-creator']
        },
        {
            id: 'group-management',
            name: 'Group Management',
            description: 'Create and manage private groups and communities',
            price: 4.99,
            currency: 'USD',
            interval: 'month',
            category: 'networking',
            appScope: 'ecosystem',
            applicableApps: ['mention', 'oxy-social', 'oxy-workspace'],
            canBePurchasedSeparately: true,
            includedInPlans: ['oxy-connect', 'oxy-premium', 'oxy-creator']
        },
        {
            id: 'creator-tools',
            name: 'Creator Tools Suite',
            description: 'Professional content creation and editing tools',
            price: 9.99,
            currency: 'USD',
            interval: 'month',
            category: 'productivity',
            appScope: 'specific',
            applicableApps: ['oxy-creator', 'oxy-studio'],
            canBePurchasedSeparately: true,
            includedInPlans: ['oxy-creator']
        },
        {
            id: 'monetization-features',
            name: 'Monetization Features',
            description: 'Revenue sharing, sponsorship tools, and creator fund access',
            price: 12.99,
            currency: 'USD',
            interval: 'month',
            category: 'productivity',
            appScope: 'specific',
            applicableApps: ['oxy-creator'],
            canBePurchasedSeparately: true,
            includedInPlans: ['oxy-creator']
        },
        {
            id: 'workspace-collaboration',
            name: 'Workspace Collaboration',
            description: 'Advanced team features and project management tools',
            price: 6.99,
            currency: 'USD',
            interval: 'month',
            category: 'productivity',
            appScope: 'specific',
            applicableApps: ['oxy-workspace'],
            canBePurchasedSeparately: true,
            includedInPlans: ['oxy-premium', 'oxy-creator']
        }
    ];

    useEffect(() => {
        detectCurrentApp();
    }, []);

    useEffect(() => {
        if (currentAppPackage) {
            loadSubscriptionData();
        }
    }, [currentAppPackage]);

    const detectCurrentApp = () => {
        const detectedApp = 'mention';
        setCurrentAppPackage(detectedApp);
    };

    const loadSubscriptionData = async () => {
        try {
            setLoading(true);

            const availablePlans = mockPlans.filter(plan =>
                plan.applicableApps.includes(currentAppPackage)
            );
            setPlans(availablePlans);

            let currentSubscription: UserSubscription | null = null;
            if (user?.isPremium) {
                currentSubscription = {
                    id: 'sub_12345',
                    planId: 'oxy-insider',
                    status: 'active',
                    currentPeriodStart: new Date().toISOString(),
                    currentPeriodEnd: new Date(Date.now() + PERIOD_MS).toISOString(),
                    cancelAtPeriodEnd: false
                };
                setSubscription(currentSubscription);
            }

            const availableFeatures = mockIndividualFeatures.filter(feature =>
                feature.applicableApps.includes(currentAppPackage)
            );

            const updatedFeatures = availableFeatures.map(feature => {
                const isIncludedInCurrentPlan = !!(currentSubscription &&
                    feature.includedInPlans.includes(currentSubscription.planId));

                return {
                    ...feature,
                    isIncludedInCurrentPlan,
                    isSubscribed: !!isIncludedInCurrentPlan
                };
            });

            setIndividualFeatures(updatedFeatures);

        } catch (error) {
            if (__DEV__) {
                console.error('Failed to load subscription data:', error);
            }
            toast.error('Failed to load subscription information');
        } finally {
            setLoading(false);
        }
    };

    const handleSubscribe = async (planId: string) => {
        try {
            const planToSubscribe = mockPlans.find(plan => plan.id === planId);
            if (!planToSubscribe?.applicableApps.includes(currentAppPackage)) {
                toast.error(t('premium.toasts.planUnavailable', { app: currentAppPackage }) || `This plan is not available for the current app (${currentAppPackage})`);
                return;
            }

            if (planId === 'mention-plus' && currentAppPackage !== 'mention') {
                toast.error(t('premium.toasts.mentionOnly') || 'Mention+ is only available in the Mention app');
                return;
            }

            setSelectedPlan(planId);
            setProcessingPayment(true);
            await new Promise(resolve => setTimeout(resolve, SUBSCRIBE_DELAY_MS));
            toast.success(t('premium.toasts.activated') || 'Subscription activated successfully!');

            setSubscription({
                id: `sub_${Date.now()}`,
                planId,
                status: 'active',
                currentPeriodStart: new Date().toISOString(),
                currentPeriodEnd: new Date(Date.now() + PERIOD_MS).toISOString(),
                cancelAtPeriodEnd: false
            });

            loadSubscriptionData();

        } catch (error) {
            if (__DEV__) {
                console.error('Payment failed:', error);
            }
            toast.error(t('premium.toasts.paymentFailed') || 'Payment failed. Please try again.');
        } finally {
            setProcessingPayment(false);
        }
    };

    const handleCancelSubscription = useCallback(async () => {
        const confirmed = await surfaces.confirm({
            title: t('premium.confirms.cancelSubTitle') || 'Cancel Subscription',
            description: t('premium.confirms.cancelSub') || 'Are you sure you want to cancel your subscription? You will lose access to premium features at the end of your current billing period.',
            confirmLabel: t('premium.actions.cancelSubBtn') || 'Cancel Subscription',
            cancelLabel: t('common.cancel') || 'Cancel',
            destructive: true,
        });
        if (!confirmed) return;
        try {
            setSubscription(prev => prev ? {
                ...prev,
                cancelAtPeriodEnd: true
            } : null);
            toast.success(t('premium.toasts.willCancel') || 'Subscription will be canceled at the end of the billing period');
        } catch (error) {
            toast.error(t('premium.toasts.cancelFailed') || 'Failed to cancel subscription');
        }
    }, [t]);

    const handleReactivateSubscription = useCallback(async () => {
        try {
            setSubscription(prev => prev ? {
                ...prev,
                cancelAtPeriodEnd: false
            } : null);
            toast.success(t('premium.toasts.reactivated') || 'Subscription reactivated successfully');
        } catch (error) {
            toast.error(t('premium.toasts.reactivateFailed') || 'Failed to reactivate subscription');
        }
    }, [t]);

    const formatPrice = (price: number, interval: string) => {
        const yearlyPrice = interval === 'year' ? price : price * MONTHS_PER_YEAR * YEARLY_DISCOUNT;
        const displayPrice = billingInterval === 'year' ? yearlyPrice : price;

        return {
            price: displayPrice,
            formatted: `$${displayPrice.toFixed(2)}`,
            interval: billingInterval === 'year' ? 'year' : 'month'
        };
    };

    const getCurrentPlan = () => {
        if (!subscription) return null;
        return plans.find(plan => plan.id === subscription.planId);
    };

    const handleFeatureSubscribe = async (featureId: string) => {
        try {
            const featureToSubscribe = mockIndividualFeatures.find(feature => feature.id === featureId);
            if (!featureToSubscribe?.applicableApps.includes(currentAppPackage)) {
                toast.error(`This feature is not available for the current app (${currentAppPackage})`);
                return;
            }

            if (featureToSubscribe.appScope === 'specific') {
                const hasExactMatch = featureToSubscribe.applicableApps.length === 1 &&
                    featureToSubscribe.applicableApps[0] === currentAppPackage;
                if (!hasExactMatch && featureToSubscribe.applicableApps.length === 1) {
                    const requiredApp = featureToSubscribe.applicableApps[0];
                    toast.error(`${featureToSubscribe.name} is only available in the ${requiredApp} app`);
                    return;
                }
            }

            setProcessingPayment(true);
            await new Promise(resolve => setTimeout(resolve, FEATURE_DELAY_MS));

            setIndividualFeatures(prev =>
                prev.map(feature =>
                    feature.id === featureId
                        ? { ...feature, isSubscribed: true }
                        : feature
                )
            );

            const feature = individualFeatures.find(f => f.id === featureId);
            toast.success((t('premium.toasts.featureSubscribed', { name: feature?.name ?? '' }) ?? `Subscribed to ${feature?.name} successfully!`));

        } catch (error) {
            if (__DEV__) {
                console.error('Feature subscription failed:', error);
            }
            toast.error(t('premium.toasts.featureSubscribeFailed') || 'Feature subscription failed. Please try again.');
        } finally {
            setProcessingPayment(false);
        }
    };

    const handleFeatureUnsubscribe = useCallback(async (featureId: string) => {
        const feature = individualFeatures.find(f => f.id === featureId);
        const confirmed = await surfaces.confirm({
            title: t('premium.confirms.unsubscribeFeatureTitle') || 'Unsubscribe from Feature',
            description: feature
                ? (t('premium.confirms.unsubscribeFeature', { name: feature.name }) ?? `Are you sure you want to unsubscribe from ${feature.name}?`)
                : '',
            confirmLabel: t('premium.actions.unsubscribe') || 'Unsubscribe',
            cancelLabel: t('common.cancel') || 'Cancel',
            destructive: true,
        });
        if (!confirmed) return;
        try {
            setIndividualFeatures(prev =>
                prev.map(f =>
                    f.id === featureId
                        ? { ...f, isSubscribed: false }
                        : f
                )
            );
            toast.success((t('premium.toasts.featureUnsubscribed', { name: feature?.name ?? '' }) ?? `Unsubscribed from ${feature?.name}`));
        } catch (error) {
            toast.error(t('premium.toasts.featureUnsubscribeFailed') || 'Failed to unsubscribe from feature');
        }
    }, [individualFeatures, t]);

    const renderCurrentSubscription = () => {
        if (!subscription) return null;

        const currentPlan = getCurrentPlan();
        if (!currentPlan) return null;

        const statusChipColor =
            subscription.status === 'active' ? 'success' :
                subscription.status === 'trialing' ? 'warning' :
                    'error';

        return (
            <View className="mb-space-24">
                <H5 className="text-text mb-space-12">
                    {t('premium.current.title') || 'Current Subscription'}
                </H5>

                <Card variant="outlined">
                  <CardBody style={{ padding: 20 }}>
                    <View className="flex-row justify-between items-start mb-space-12">
                        <View className="flex-1 pr-space-12">
                            <H4 className="text-text" numberOfLines={1}>{currentPlan.name}</H4>
                            <Text className="text-text-secondary text-sm mt-space-2">
                                {`$${currentPlan.price}/month`}
                            </Text>
                        </View>
                        <Badge variant="subtle" color={statusChipColor} size="large" content={subscription.status.toUpperCase()} />
                    </View>

                    <Text className="text-text-secondary text-sm mb-space-16">
                        {t('premium.current.renewsOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString() }) || `Renews on ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`}
                    </Text>

                    {subscription.cancelAtPeriodEnd && (
                        <View className="flex-row items-center bg-fill-secondary rounded-radius-12 p-space-12 mb-space-16">
                            <Ionicons name="warning" size={16} color={colors.warning} />
                            <Text className="text-text-secondary text-sm ml-space-8 flex-1">
                                {t('premium.current.willCancelOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString() }) || `Subscription will cancel on ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`}
                            </Text>
                        </View>
                    )}

                    <View className="flex-row gap-space-12">
                        {subscription.cancelAtPeriodEnd ? (
                            <Button
                                variant="primary"
                                onPress={handleReactivateSubscription}
                                className="flex-1"
                                accessibilityLabel={t('premium.actions.reactivate') || 'Reactivate'}
                            >
                                {t('premium.actions.reactivate') || 'Reactivate'}
                            </Button>
                        ) : (
                            <Button
                                variant="destructive"
                                onPress={handleCancelSubscription}
                                className="flex-1"
                                accessibilityLabel={t('premium.actions.cancelSubBtn') || 'Cancel Subscription'}
                            >
                                {t('premium.actions.cancelSubBtn') || 'Cancel Subscription'}
                            </Button>
                        )}

                        <Button
                            variant="outline"
                            onPress={() => navigate?.('PaymentGateway')}
                            className="flex-1"
                            accessibilityLabel={t('premium.actions.manageBilling') || 'Manage Billing'}
                        >
                            {t('premium.actions.manageBilling') || 'Manage Billing'}
                        </Button>
                    </View>
                  </CardBody>
                </Card>
            </View>
        );
    };

    const renderBillingToggle = () => (
        <View className="mb-space-24">
            <SegmentedControl<BillingInterval>
                label={t('premium.billing.label') || 'Billing period'}
                type="tabs"
                value={billingInterval}
                onChange={setBillingInterval}
            >
                <SegmentedControlItem value={BILLING_MONTH}>
                    <SegmentedControlItemText>
                        {t('premium.billing.monthly') || 'Monthly'}
                    </SegmentedControlItemText>
                </SegmentedControlItem>
                <SegmentedControlItem value={BILLING_YEAR}>
                    <SegmentedControlItemText>
                        {t('premium.billing.yearly') || 'Yearly'}
                    </SegmentedControlItemText>
                </SegmentedControlItem>
            </SegmentedControl>

            {billingInterval === 'year' && (
                <Text className="text-text-secondary text-sm text-center mt-space-12 font-medium">
                    {t('premium.billing.saveYearly') || 'Save 20% with yearly billing'}
                </Text>
            )}
        </View>
    );

    const renderPlanCard = (plan: SubscriptionPlan) => {
        const pricing = formatPrice(plan.price, plan.interval);
        const isSelected = selectedPlan === plan.id;
        const isCurrentPlan = subscription?.planId === plan.id;
        const isAppSpecific = plan.appScope === 'specific' && plan.applicableApps.length === 1;
        const isAvailableForCurrentApp = plan.applicableApps.includes(currentAppPackage);

        const getAppScopeText = () => {
            if (plan.appScope === 'ecosystem') {
                return t('premium.plan.scope.allApps') || 'Works across all Oxy apps';
            }
            if (isAppSpecific) {
                const appName = plan.applicableApps[0];
                return t('premium.plan.scope.exclusive', { app: appName }) || `Exclusive to ${appName} app`;
            }
            return t('premium.plan.scope.availableIn', { apps: plan.applicableApps.join(', ') }) || `Available in: ${plan.applicableApps.join(', ')}`;
        };

        const getAvailabilityStatus = () => {
            if (isAppSpecific && !isAvailableForCurrentApp) {
                const requiredApp = plan.applicableApps[0];
                return {
                    available: false,
                    reason: t('premium.plan.scope.exclusive', { app: requiredApp }) || `Only available in ${requiredApp} app`
                };
            }
            return { available: true, reason: null };
        };

        const availability = getAvailabilityStatus();

        return (
            <Card
                key={plan.id}
                variant="outlined"
                style={[
                    { marginBottom: 16 },
                    !availability.available ? { opacity: 0.6 } : null,
                    (isSelected || plan.isPopular) ? { borderColor: colors.primary, borderWidth: 2 } : null,
                ]}
            >
              <CardBody style={{ padding: 20 }}>
                <View className="flex-row flex-wrap gap-space-8 mb-space-12">
                    {plan.isPopular && (
                        <Badge variant="solid" color="primary" size="large" content={t('premium.plan.badge.mostPopular') || 'Most Popular'} />
                    )}
                    {isAppSpecific && (
                        <Badge
                            variant="subtle"
                            color={isAvailableForCurrentApp ? 'success' : 'warning'}
                            size="large"
                            content={isAvailableForCurrentApp
                                ? (t('premium.plan.badge.appExclusive') || 'App Exclusive')
                                : (t('premium.plan.badge.notAvailable') || 'Not Available')}
                        />
                    )}
                </View>

                <View className="mb-space-16">
                    <H4 className="text-text mb-space-4">{plan.name}</H4>
                    <Text className="text-text-secondary text-sm">
                        {plan.description}
                    </Text>
                    <Text className="text-text-tertiary text-xs mt-space-4 italic">
                        {getAppScopeText()}
                    </Text>
                    {!availability.available && (
                        <Text className="text-xs mt-space-4 font-medium" style={{ color: colors.error }}>
                            {availability.reason}
                        </Text>
                    )}
                </View>

                <View className="flex-row items-baseline mb-space-20">
                    <H2 className="text-text">{pricing.formatted}</H2>
                    <Text className="text-text-secondary text-sm ml-space-4">
                        {t('premium.plan.perInterval', { interval: pricing.interval }) || `per ${pricing.interval}`}
                    </Text>
                </View>

                <BenefitList className="mb-space-24">
                    {plan.features.map((feature) => (
                        <BenefitRow
                            key={feature}
                            icon={<Ionicons name="checkmark" size={18} color={colors.success} />}
                            label={feature}
                        />
                    ))}
                </BenefitList>

                {isCurrentPlan ? (
                    <Button
                        variant="secondary"
                        disabled
                        icon={<Ionicons name="checkmark-circle" size={18} color={colors.success} />}
                        accessibilityLabel={t('premium.plan.current') || 'Current Plan'}
                        className="w-full"
                    >
                        {t('premium.plan.current') || 'Current Plan'}
                    </Button>
                ) : !availability.available ? (
                    <Button
                        variant="secondary"
                        disabled
                        accessibilityLabel={t('premium.plan.notAvailableInApp') || 'Not Available in Current App'}
                        className="w-full"
                    >
                        {t('premium.plan.notAvailableInApp') || 'Not Available in Current App'}
                    </Button>
                ) : (
                    <Button
                        variant={plan.isPopular ? 'primary' : 'secondary'}
                        onPress={() => handleSubscribe(plan.id)}
                        disabled={processingPayment}
                        loading={processingPayment && isSelected}
                        accessibilityLabel={t('premium.actions.subscribeTo', { name: plan.name }) || `Subscribe to ${plan.name}`}
                        className="w-full"
                    >
                        {t('premium.actions.subscribeTo', { name: plan.name }) || `Subscribe to ${plan.name}`}
                    </Button>
                )}
              </CardBody>
            </Card>
        );
    };

    const renderTabNavigation = () => (
        <View className="mb-space-24">
            <SegmentedControl<ActiveTab>
                label={t('premium.tabs.label') || 'Subscription type'}
                type="tabs"
                value={activeTab}
                onChange={setActiveTab}
            >
                <SegmentedControlItem value={TAB_PLANS}>
                    <SegmentedControlItemText>
                        {t('premium.tabs.plans') || 'Full Plans'}
                    </SegmentedControlItemText>
                </SegmentedControlItem>
                <SegmentedControlItem value={TAB_FEATURES}>
                    <SegmentedControlItemText>
                        {t('premium.tabs.features') || 'Individual Features'}
                    </SegmentedControlItemText>
                </SegmentedControlItem>
            </SegmentedControl>
        </View>
    );

    const renderFeatureCard = (feature: IndividualFeature) => {
        const pricing = formatPrice(feature.price, feature.interval);
        const isSubscribed = feature.isSubscribed;
        const isIncludedInCurrentPlan = feature.isIncludedInCurrentPlan;
        const canPurchase = feature.canBePurchasedSeparately && !isIncludedInCurrentPlan;

        const getCategoryColor = (category: string) => {
            switch (category) {
                case 'analytics': return colors.warning;
                case 'customization': return colors.secondary;
                case 'content': return colors.success;
                case 'networking': return colors.info;
                case 'productivity': return colors.error;
                default: return colors.primary;
            }
        };

        const getCategoryIcon = (category: string): IoniconName => {
            switch (category) {
                case 'analytics': return 'analytics';
                case 'customization': return 'color-palette';
                case 'content': return 'document-text';
                case 'networking': return 'people';
                case 'productivity': return 'briefcase';
                default: return 'star';
            }
        };

        const getAppScopeText = () => {
            if (feature.appScope === 'ecosystem') {
                return t('premium.feature.scope.allApps');
            }
            return t('premium.feature.scope.availableIn', { apps: feature.applicableApps.join(', ') }) || `Available in: ${feature.applicableApps.join(', ')}`;
        };

        return (
            <Card
                key={feature.id}
                variant="outlined"
                style={[
                    { marginBottom: 12 },
                    isIncludedInCurrentPlan
                        ? { borderColor: colors.primary, borderWidth: 2 }
                        : isSubscribed
                            ? { borderColor: colors.success, borderWidth: 2 }
                            : null,
                ]}
            >
              <CardBody style={{ padding: 16 }}>
                <View className="flex-row items-start mb-space-12">
                    <View
                        className="bg-fill-secondary rounded-radius-max items-center justify-center mr-space-12"
                        style={{ width: 40, height: 40 }}
                    >
                        <Ionicons
                            name={getCategoryIcon(feature.category)}
                            size={24}
                            color={getCategoryColor(feature.category)}
                        />
                    </View>
                    <View className="flex-1">
                        <View className="flex-row items-center justify-between mb-space-4">
                            <H5 className="text-text flex-1 pr-space-8" numberOfLines={1}>{feature.name}</H5>
                            {isIncludedInCurrentPlan && (
                                <Badge variant="solid" color="primary" size="large" content={t('premium.feature.included') || 'Included'} />
                            )}
                        </View>
                        <Text className="text-text-secondary text-sm">
                            {feature.description}
                        </Text>
                        <Text className="text-text-tertiary text-xs mt-space-4 italic">
                            {getAppScopeText()}
                        </Text>
                    </View>
                </View>

                {!isIncludedInCurrentPlan && (
                    <View className="items-center mb-space-16">
                        <H4 className="text-text">{pricing.formatted}</H4>
                        <Text className="text-text-secondary text-sm mt-space-2">
                            {t('premium.plan.perInterval', { interval: pricing.interval }) || `per ${pricing.interval}`}
                        </Text>
                    </View>
                )}

                {isIncludedInCurrentPlan ? (
                    <Button
                        variant="primary"
                        disabled
                        icon={<Ionicons name="checkmark-circle" size={16} color={colors.primaryForeground} />}
                        accessibilityLabel={t('premium.feature.includedInPlan') || 'Included in your plan'}
                        className="w-full"
                    >
                        {t('premium.feature.includedInPlan') || 'Included in your plan'}
                    </Button>
                ) : isSubscribed ? (
                    <View className="flex-row gap-space-8">
                        <Button
                            variant="secondary"
                            disabled
                            icon={<Ionicons name="checkmark" size={16} color={colors.success} />}
                            accessibilityLabel={t('premium.feature.subscribed') || 'Subscribed'}
                            className="flex-1"
                        >
                            {t('premium.feature.subscribed') || 'Subscribed'}
                        </Button>
                        <Button
                            variant="outline"
                            onPress={() => handleFeatureUnsubscribe(feature.id)}
                            accessibilityLabel={t('premium.actions.unsubscribe') || 'Unsubscribe'}
                            className="flex-1"
                        >
                            {t('premium.actions.unsubscribe') || 'Unsubscribe'}
                        </Button>
                    </View>
                ) : canPurchase ? (
                    <Button
                        variant="primary"
                        onPress={() => handleFeatureSubscribe(feature.id)}
                        disabled={processingPayment}
                        loading={processingPayment}
                        accessibilityLabel={t('premium.actions.subscribe') || 'Subscribe'}
                        className="w-full"
                    >
                        {t('premium.actions.subscribe') || 'Subscribe'}
                    </Button>
                ) : (
                    <Button
                        variant="secondary"
                        disabled
                        accessibilityLabel={t('premium.feature.plansOnly') || 'Only available in subscription plans'}
                        className="w-full"
                    >
                        {t('premium.feature.plansOnly') || 'Only available in subscription plans'}
                    </Button>
                )}
              </CardBody>
            </Card>
        );
    };

    const renderIndividualFeatures = () => (
        <View className="mb-space-24">
            <H4 className="text-text mb-space-8">
                {t('premium.features.title') || 'Individual Features'}
            </H4>
            <Text className="text-text-secondary text-base mb-space-16">
                {t('premium.features.subtitle') || 'Subscribe to specific features you need. Some features are included in subscription plans.'}
            </Text>

            {FEATURE_CATEGORIES.map(category => {
                const categoryFeatures = individualFeatures.filter(f => f.category === category);
                if (categoryFeatures.length === 0) return null;

                return (
                    <View key={category} className="mb-space-24">
                        <H5 className="text-text mb-space-12">
                            {category.charAt(0).toUpperCase() + category.slice(1)}
                        </H5>
                        {categoryFeatures.map(renderFeatureCard)}
                    </View>
                );
            })}
        </View>
    );

    // Show different app contexts for testing (development only).
    const [showAppSwitcher] = useState(__DEV__);

    const renderAppSwitcher = () => {
        if (!showAppSwitcher) return null;

        const testApps = ['mention', 'oxy-social', 'oxy-workspace', 'oxy-creator'];

        return (
            <View className="bg-fill-secondary border border-border-image rounded-radius-12 p-space-16 mb-space-24">
                <Text className="text-text-secondary text-sm font-medium mb-space-12">
                    {t('premium.dev.appContext') || 'Test App Context (Dev Only)'}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View className="flex-row gap-space-8">
                        {testApps.map(app => (
                            <Chip
                                key={app}
                                variant={currentAppPackage === app ? 'solid' : 'outlined'}
                                color="primary"
                                onPress={() => setCurrentAppPackage(app)}
                            >
                                {app}
                            </Chip>
                        ))}
                    </View>
                </ScrollView>
            </View>
        );
    };

    if (loading) {
        return (
            <>
                <View className="items-center justify-center px-screen-margin py-space-40">
                    <ActivityIndicator size="large" color={colors.primary} />
                    <Text className="text-text-secondary text-base text-center mt-space-16">
                        {t('premium.loading') || 'Loading subscription plans...'}
                    </Text>
                </View>
            </>
        );
    }

    return (
        <>

            <View className="px-screen-margin pb-space-32">
                <View className="pt-space-20">
                    {renderAppSwitcher()}

                    {subscription && renderCurrentSubscription()}

                    {!subscription && (
                        <View className="mb-space-24">
                            <H2 className="text-text mb-space-8">
                                {t('premium.choosePlan') || 'Choose Your Plan'}
                            </H2>
                            <Text className="text-text-secondary text-base">
                                {t('premium.choosePlanSubtitle') || 'Unlock premium features and take your experience to the next level'}
                            </Text>
                        </View>
                    )}

                    {!subscription && renderTabNavigation()}

                    {!subscription && activeTab === TAB_PLANS && renderBillingToggle()}

                    {activeTab === TAB_PLANS ? (
                        <View className="mb-space-24">
                            {!subscription && (
                                <H4 className="text-text mb-space-12">
                                    {t('premium.availablePlans') || 'Available Plans'}
                                </H4>
                            )}

                            {plans.map(renderPlanCard)}
                        </View>
                    ) : (
                        renderIndividualFeatures()
                    )}

                    {/* Why go premium */}
                    <View className="mb-space-24">
                        <H4 className="text-text mb-space-12">
                            {t('premium.why') || 'Why Go Premium?'}
                        </H4>

                        <BenefitList>
                            {([
                                {
                                    icon: 'flash' as IoniconName,
                                    color: colors.primary,
                                    title: t('premium.benefits.performance.title') || 'Enhanced Performance',
                                    desc: t('premium.benefits.performance.desc') || 'Faster processing and priority access to our servers',
                                },
                                {
                                    icon: 'shield-checkmark' as IoniconName,
                                    color: colors.success,
                                    title: t('premium.benefits.security.title') || 'Advanced Security',
                                    desc: t('premium.benefits.security.desc') || 'Enhanced encryption and security features',
                                },
                                {
                                    icon: 'headset' as IoniconName,
                                    color: colors.warning,
                                    title: t('premium.benefits.support.title') || 'Priority Support',
                                    desc: t('premium.benefits.support.desc') || 'Get help faster with our premium support team',
                                },
                            ]).map((benefit) => (
                                <BenefitRow
                                    key={benefit.title}
                                    icon={<Ionicons name={benefit.icon} size={18} color={benefit.color} />}
                                    accessibilityLabel={`${benefit.title}. ${benefit.desc}`}
                                >
                                    <Text className="text-text font-medium text-sm">{benefit.title}</Text>
                                    {`\n${benefit.desc}`}
                                </BenefitRow>
                            ))}
                        </BenefitList>
                    </View>
                </View>
            </View>
        </>
    );
};

export default PremiumSubscriptionScreen;
