import { useContext, useState } from 'react';
import { Image, Linking, View } from 'react-native';
import { SubscriptionPlans } from '@oxy.so/bloom/subscription-plans';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { StepperRow } from '@oxy.so/bloom/stepper';
import { Text } from '@oxy.so/bloom/typography';
import { toast } from '@oxy.so/bloom/toast';
import {
  getOnePlans,
  onePlanQuote,
  OXY_ONE_APP_SUBSCRIPTIONS,
  OXY_ONE_FAMILY_MEMBERS,
  type OneAudience,
  type PersonalPlanMode,
} from '@oxy.so/contracts/client';
import { useTheme } from '@oxy.so/bloom/theme';
import { SettingsIcon } from '../components/SettingsIcon';
import { OxySupportContext } from '../context/oxySupportContext';
import floralPoster from '../../assets/one/floral.jpg';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';

const apps = {
  personal: ['alia', 'mention', 'inbox', 'noted', 'clarity', 'homiio'],
  creator: ['alia', 'mention', 'inbox', 'noted', 'clarity', 'schedio', 'mercaria'],
  business: ['alia', 'mention', 'inbox', 'noted', 'clarity', 'schedio'],
} as const;

/** The shared Bloom presentation, populated with Oxy's approved commercial terms.
 * Preview does not infer active entitlements or submit a purchase. */
export default function OxyOneScreen() {
  const { t, locale } = useI18n();
  const theme = useTheme();
  const { oxyOneArtwork } = useContext(OxySupportContext);
  const [audience, setAudience] = useState<OneAudience>('personal');
  const [mode, setMode] = useState<PersonalPlanMode>('individual');
  const [period, setPeriod] = useState<'monthly' | 'annual'>('monthly');
  const [selected, setSelected] = useState('Pro');
  const [seats, setSeats] = useState(1);
  useSurfaceHeader({ title: 'Oxy One', titleLayout: 'hero' });
  const money = (cents: number) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(cents / 100);
  const number = (n: number) => n.toLocaleString(locale);
  const plans = getOnePlans(audience, mode).map((plan) => {
    const quote = onePlanQuote(plan, period, seats);
    if (
      quote.totalMonthly === undefined ||
      quote.totalAnnual === undefined ||
      quote.monthlyCredits === undefined
    )
      throw new Error('Oxy One preview requires a team size');
    const tier = plan.name as keyof typeof OXY_ONE_APP_SUBSCRIPTIONS.alia.tiers;
    const bundled = apps[audience].flatMap((key) => {
      const app = OXY_ONE_APP_SUBSCRIPTIONS[key];
      const appTier =
        audience === 'creator' && 'creatorTiers' in app ? app.creatorTiers[tier] : app.tiers[tier];
      return appTier ? [`${app.name} ${appTier}`] : [];
    });
    const storage = quote.storageGB ?? plan.storageGB;
    const free = plan.name === 'Free';
    return {
      id: plan.name,
      label: plan.name,
      subtitle: t(`oxyOne.subtitle.${audience}`),
      price: free
        ? t('oxyOne.free')
        : period === 'annual'
          ? t('oxyOne.annualPrice', {
              price: money(quote.totalMonthly),
              total: money(quote.totalAnnual),
            })
          : t('oxyOne.monthlyPrice', { price: money(quote.totalMonthly) }),
      benefits: [
        {
          id: 'credits',
          title: free
            ? t('oxyOne.payAsYouGo')
            : t('oxyOne.credits', { count: number(quote.monthlyCredits) }),
          description: t('oxyOne.creditsDescription'),
          icon: <SettingsIcon color={theme.colors.primary} name="star" />,
        },
        {
          id: 'storage',
          title: t('oxyOne.storage', {
            amount: `${number(storage >= 1000 ? storage / 1000 : storage)} ${storage >= 1000 ? 'TB' : 'GB'}`,
          }),
          description: t('oxyOne.storageDescription'),
          icon: <SettingsIcon color={theme.colors.primary} name="cloud-outline" />,
        },
        ...(bundled.length
          ? [
              {
                id: 'apps',
                title: t('oxyOne.apps'),
                description: bundled.join(' · '),
                icon: <SettingsIcon color={theme.colors.primary} name="apps" />,
              },
            ]
          : []),
        ...(plan.creditDiscount
          ? [
              {
                id: 'discount',
                title: t('oxyOne.discount', { percent: plan.creditDiscount }),
                description: t('oxyOne.discountDescription'),
                icon: <SettingsIcon color={theme.colors.primary} name="tag" />,
              },
            ]
          : []),
        ...(audience === 'personal' && mode === 'family'
          ? [
              {
                id: 'family',
                title: t('oxyOne.familyMembers', { count: OXY_ONE_FAMILY_MEMBERS }),
                description: t('oxyOne.familyDescription'),
                icon: <SettingsIcon color={theme.colors.primary} name="account-group" />,
              },
            ]
          : []),
        ...(audience === 'business'
          ? [
              {
                id: 'business-app',
                title: t('oxyOne.businessApp'),
                description: t('oxyOne.businessAppChoice', {
                  mercaria: `Mercaria ${OXY_ONE_APP_SUBSCRIPTIONS.mercaria.tiers[tier]}`,
                }),
                icon: <SettingsIcon color={theme.colors.primary} name="apps" />,
              },
              {
                id: 'seats',
                title: t('oxyOne.seats', { count: seats }),
                description: t('oxyOne.seatPrice', {
                  base: money(quote.baseMonthly),
                  seat: money(quote.seatMonthly ?? 0),
                }),
                icon: <SettingsIcon color={theme.colors.primary} name="account-group" />,
              },
            ]
          : []),
      ],
    };
  });
  const segments = (
    label: string,
    value: string,
    options: readonly string[],
    change: (value: string) => void,
  ) => (
    <SegmentedControl
      type="radio"
      label={t(`oxyOne.${label}`)}
      value={value}
      onValueChange={change}
      size="sm"
    >
      {options.map((option) => (
        <SegmentedControlItem key={option} value={option}>
          <SegmentedControlItemText>{t(`oxyOne.${option}`)}</SegmentedControlItemText>
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
  return (
    <SubscriptionPlans
      productName="Oxy One"
      heroBackground={
        oxyOneArtwork ?? (
          <Image
            source={floralPoster}
            resizeMode="cover"
            style={{ width: '100%', height: '100%' }}
          />
        )
      }
      plans={plans}
      value={selected}
      onValueChange={setSelected}
      selectorLabel={t('oxyOne.choosePlan')}
      controls={
        <View style={{ gap: 12 }}>
          {segments('audience', audience, ['personal', 'creator', 'business'], (value) => {
            setAudience(value as OneAudience);
            if (selected === 'Free') setSelected('Go');
          })}
          {audience === 'personal' &&
            segments('members', mode, ['individual', 'family'], (value) => {
              setMode(value as PersonalPlanMode);
              if (selected === 'Free') setSelected('Go');
            })}
          {segments('billing', period, ['monthly', 'annual'], (value) =>
            setPeriod(value as 'monthly' | 'annual'),
          )}
          {audience === 'business' && (
            <StepperRow
              title={t('oxyOne.teamSize')}
              value={seats}
              min={1}
              max={1000}
              onValueChange={setSeats}
            />
          )}
        </View>
      }
      terms={<Text>{t('oxyOne.preview')}</Text>}
      primaryAction={{ label: t('oxyOne.unavailable'), disabled: true, onPress: () => undefined }}
      moreBenefits={{
        label: t('oxyOne.more'),
        onPress: () => {
          void Linking.openURL('https://oxy.so/one').catch(() => toast.error(t('help.linkError')));
        },
      }}
    />
  );
}
