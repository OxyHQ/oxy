import { Text, View } from 'react-native';

import { DocCode, DocNextSteps, DocP, DocPage, DocSection } from '@/components/docs/DocParts';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { ModelPlaceholderNotice } from '@/components/model-placeholder-notice';
import { useTranslation } from '@/lib/i18n';
import { MODEL_ID_PLACEHOLDER } from '@/lib/model-reference';

function StepTitle({ step, children }: { step: number; children: string }) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="h-8 w-8 items-center justify-center rounded-full bg-primary">
        <Text className="text-sm font-semibold text-primary-foreground">{step}</Text>
      </View>
      <Text accessibilityRole="header" className="flex-1 text-lg font-semibold text-foreground">
        {children}
      </Text>
    </View>
  );
}

const MINT_TOKEN = `OXY_ACCESS_TOKEN=$(curl -s https://api.oxy.so/auth/service-token \\
  -H "Content-Type: application/json" \\
  -d "{\\"apiKey\\": \\"$OXY_CLIENT_ID\\", \\"apiSecret\\": \\"$OXY_CLIENT_SECRET\\"}" \\
  | jq -r .data.token)`;

const FIRST_REQUEST = `curl https://api.oxy.so/v1/chat/completions \\
  -H "Authorization: Bearer $OXY_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${MODEL_ID_PLACEHOLDER}",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`;

const RESPONSE = `{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "${MODEL_ID_PLACEHOLDER}",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you today?"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 15,
    "total_tokens": 25
  }
}`;

const CREDENTIAL_ENV = `OXY_CLIENT_ID=oxy_dk_your_client_id
OXY_CLIENT_SECRET=shown_once_when_you_create_it`;

export default function QuickStartScreen() {
  const { t } = useTranslation();

  return (
    <DocPage title={t('docs.quickstart.title')} subtitle={t('docs.quickstart.subtitle')}>
      <DocSection>
        <StepTitle step={1}>{t('docs.quickstart.step1.title')}</StepTitle>
        <DocP>{t('docs.quickstart.step1.body')}</DocP>
        <DocCode code={CREDENTIAL_ENV} title={t('docs.quickstart.step1.credential')} />
      </DocSection>

      <DocSection>
        <StepTitle step={2}>{t('docs.quickstart.step2.title')}</StepTitle>
        <DocP>{t('docs.quickstart.step2.body')}</DocP>
        <Text className="text-xs font-medium text-muted-foreground">
          {t('docs.quickstart.step2.node')}
        </Text>
        <DocCode code="npm install openai" title={t('docs.quickstart.step2.terminal')} />
        <Text className="text-xs font-medium text-muted-foreground">
          {t('docs.quickstart.step2.python')}
        </Text>
        <DocCode code="pip install openai" title={t('docs.quickstart.step2.terminal')} />
      </DocSection>

      <DocSection>
        <StepTitle step={3}>{t('docs.quickstart.step3.title')}</StepTitle>
        <DocP>{t('docs.quickstart.step3.mint')}</DocP>
        <DocCode code={MINT_TOKEN} language="bash" title={t('docs.quickstart.step3.mintTitle')} />
        <DocP>{t('docs.quickstart.step3.call')}</DocP>
        <InferenceAvailabilityNotice />
        <ModelPlaceholderNotice />
        <DocCode
          code={FIRST_REQUEST}
          language="bash"
          title={t('docs.quickstart.step3.requestTitle')}
        />
      </DocSection>

      <DocSection>
        <StepTitle step={4}>{t('docs.quickstart.step4.title')}</StepTitle>
        <DocP>{t('docs.quickstart.step4.body')}</DocP>
        <DocCode code={RESPONSE} language="json" title={t('docs.quickstart.step4.responseTitle')} />
      </DocSection>

      <DocNextSteps
        steps={[
          {
            href: '/documentation/authentication',
            label: t('docs.quickstart.next.authentication'),
          },
          { href: '/documentation/chat-completions', label: t('docs.quickstart.next.chat') },
          { href: '/examples', label: t('docs.quickstart.next.examples') },
        ]}
      />
    </DocPage>
  );
}
