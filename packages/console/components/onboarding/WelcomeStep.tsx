import { Checkbox } from '@oxy.so/bloom/checkbox';
import { WizardFooter, WizardProgress } from '@oxy.so/bloom/wizard';
import { H1, Muted } from '@oxy.so/bloom/typography';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';
import { View } from 'react-native';

import { useConsoleOnboarding } from '@/hooks/use-console-onboarding';
import { getErrorMessage } from '@/lib/api-error';
import config from '@/lib/config';
import { useTranslation } from '@/lib/i18n';
import { canAcceptTerms } from '@/lib/onboarding';
import { LinkedText } from './LinkedText';
import { OnboardingFrame } from './OnboardingFrame';
import { UseCasePreview } from './UseCasePreview';

/** Step 1: the terms, with the two required acknowledgements and the optional email opt-in. */
export function WelcomeStep() {
  const { t } = useTranslation();
  const { acceptTerms } = useConsoleOnboarding();
  const [adult, setAdult] = useState(false);
  const [aup, setAup] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const { legalUrls } = config;

  const submit = () => {
    if (!canAcceptTerms({ adult, aup })) return;
    acceptTerms.mutate(
      { marketingOptIn: marketing },
      { onError: (error) => toast.error(getErrorMessage(error, t('onboarding.saveFailed'))) },
    );
  };

  return (
    <OnboardingFrame
      preview={<UseCasePreview useCase="explore-platform" />}
      form={
        <>
          <WizardProgress
            steps={[
              { title: t('onboarding.steps.terms') },
              { title: t('onboarding.steps.useCases') },
            ]}
            current={0}
            hideTitle
            formatStepCount={(position, total) => t('onboarding.stepCount', { position, total })}
          />
          <View className="gap-2">
            <H1 style={{ textAlign: 'left' }}>{t('onboarding.welcome.title')}</H1>
            <Muted>{t('onboarding.welcome.subtitle')}</Muted>
          </View>
          <LinkedText
            className="text-sm text-muted-foreground"
            template={t('onboarding.welcome.notice')}
            links={{
              dataUse: { label: t('onboarding.welcome.dataUseLink'), href: legalUrls.dataUse },
            }}
          />
          <View className="gap-4">
            <Checkbox
              checked={adult}
              onCheckedChange={setAdult}
              label={t('onboarding.welcome.adult')}
            />
            <Checkbox checked={aup} onCheckedChange={setAup} label={t('onboarding.welcome.aup')} />
            <Checkbox
              checked={marketing}
              onCheckedChange={setMarketing}
              label={t('onboarding.welcome.marketing')}
            />
          </View>
          <LinkedText
            className="text-sm text-muted-foreground"
            template={t('onboarding.welcome.agree')}
            links={{
              terms: { label: t('onboarding.welcome.termsLink'), href: legalUrls.terms },
              aup: { label: t('onboarding.welcome.aupLink'), href: legalUrls.aup },
              privacy: { label: t('onboarding.welcome.privacyLink'), href: legalUrls.privacy },
            }}
          />
          <WizardFooter
            sticky={false}
            onNext={submit}
            nextLabel={t('onboarding.continue')}
            nextDisabled={!canAcceptTerms({ adult, aup })}
            loading={acceptTerms.isPending}
          />
        </>
      }
    />
  );
}
