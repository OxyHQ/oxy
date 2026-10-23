import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiBankCardLine } from '@oxy.so/bloom/icons/RiBankCardLine';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiCodeLine } from '@oxy.so/bloom/icons/RiCodeLine';
import { RiCompass3Line } from '@oxy.so/bloom/icons/RiCompass3Line';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { RiStackLine } from '@oxy.so/bloom/icons/RiStackLine';
import { Item } from '@oxy.so/bloom/item';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { H1, Muted } from '@oxy.so/bloom/typography';
import { WizardFooter, WizardProgress } from '@oxy.so/bloom/wizard';
import { CONSOLE_USE_CASES, type ConsoleUseCaseId } from '@oxy.so/contracts/client';
import { useState } from 'react';
import { View } from 'react-native';

import { useConsoleOnboarding } from '@/hooks/use-console-onboarding';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import {
  normalizeDescription,
  toggleUseCase,
  USE_CASE_DESCRIPTION_MAX_LENGTH,
} from '@/lib/onboarding';
import { OnboardingFrame } from './OnboardingFrame';
import { UseCasePreview } from './UseCasePreview';

const ICONS = {
  'build-with-api': RiCodeLine,
  'ai-models': RiRobot2Line,
  'publish-apps': RiStackLine,
  'billing-credits': RiBankCardLine,
  'explore-platform': RiCompass3Line,
} as const;

/** Step 2: what the console is for. Skip saves an empty answer. */
export function UseCasesStep() {
  const { t } = useTranslation();
  const { saveUseCases } = useConsoleOnboarding();
  const [selected, setSelected] = useState<ConsoleUseCaseId[]>([]);
  const [highlighted, setHighlighted] = useState<ConsoleUseCaseId>(CONSOLE_USE_CASES[0]);
  const [description, setDescription] = useState('');

  const save = (input: { useCases: ConsoleUseCaseId[]; description?: string }) =>
    saveUseCases.mutate(input, {
      onError: (error) => toast.error(getErrorMessage(error, t('onboarding.saveFailed'))),
    });

  return (
    <OnboardingFrame
      preview={<UseCasePreview useCase={highlighted} />}
      form={
        <>
          <WizardProgress
            steps={[
              { title: t('onboarding.steps.terms') },
              { title: t('onboarding.steps.useCases') },
            ]}
            current={1}
            hideTitle
            formatStepCount={(position, total) => t('onboarding.stepCount', { position, total })}
          />
          <View className="gap-2">
            <H1 style={{ textAlign: 'left' }}>{t('onboarding.useCases.title')}</H1>
            <Muted>{t('onboarding.useCases.subtitle')}</Muted>
          </View>
          <View className="gap-1" accessibilityRole="list">
            {CONSOLE_USE_CASES.map((id) => {
              const Icon = ICONS[id];
              const checked = selected.includes(id);
              return (
                <Item
                  key={id}
                  role="checkbox"
                  title={t(`onboarding.useCases.options.${id}`)}
                  leading={<Icon size="md" />}
                  trailing={checked ? <RiCheckLine size="md" /> : <RiAddLine size="md" />}
                  selected={checked}
                  highlighted={highlighted === id}
                  onHoverIn={() => setHighlighted(id)}
                  onPress={() => {
                    setHighlighted(id);
                    setSelected((current) => toggleUseCase(current, id));
                  }}
                />
              );
            })}
          </View>
          <Textarea
            label={t('onboarding.useCases.descriptionLabel')}
            value={description}
            onValueChange={setDescription}
            maxLength={USE_CASE_DESCRIPTION_MAX_LENGTH}
            showCount
            rows={4}
          />
          <WizardFooter
            sticky={false}
            backLabel={t('onboarding.skip')}
            onBack={() => save({ useCases: [] })}
            backDisabled={saveUseCases.isPending}
            nextLabel={t('onboarding.continue')}
            onNext={() =>
              save({ useCases: selected, description: normalizeDescription(description) })
            }
            loading={saveUseCases.isPending}
          />
        </>
      }
    />
  );
}
