import { Badge } from '@oxy.so/bloom/badge';
import { Text, View } from 'react-native';

import { Notice } from '@/components/content/Notice';
import { RichText } from '@/components/content/RichText';
import {
  DocCode,
  DocHeading,
  DocNextSteps,
  DocP,
  DocPage,
  DocSection,
} from '@/components/docs/DocParts';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { useTranslation } from '@/lib/i18n';
import { MODEL_ID_PLACEHOLDER } from '@/lib/model-reference';

const SCOPES = [
  { scope: 'inference:invoke', key: 'invoke' },
  { scope: 'inference:models:read', key: 'modelsRead' },
  { scope: 'inference:usage:read', key: 'usageRead' },
  { scope: 'inference:routing:read', key: 'routingRead' },
  { scope: 'inference:providers:read', key: 'providersRead' },
  { scope: 'inference:routing:write', key: 'routingWrite' },
  { scope: 'inference:providers:write', key: 'providersWrite' },
] as const;

const SECURITY_TIPS = ['env', 'separate', 'rotate', 'minimum', 'revoke'] as const;

const ERRORS = [
  { status: '401', key: 'unauthorized' },
  { status: '403', key: 'forbidden' },
  { status: '429', key: 'rateLimited' },
] as const;

const SERVICE_TOKEN = `curl https://api.oxy.so/auth/service-token \\
  -H "Content-Type: application/json" \\
  -d '{"apiKey": "$OXY_CLIENT_ID", "apiSecret": "$OXY_CLIENT_SECRET"}'

# => { "data": { "token": "<service token>", "expiresIn": 3600 } }

curl https://api.oxy.so/some/endpoint \\
  -H "Authorization: Bearer $OXY_SERVICE_TOKEN"`;

const MACHINE_REQUEST = `curl https://api.oxy.so/v1/responses \\
  -H "Authorization: Bearer $OXY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${MODEL_ID_PLACEHOLDER}", "input": "hello"}'`;

const RATE_LIMIT_HEADERS = `X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1234567890`;

export default function AuthenticationScreen() {
  const { t } = useTranslation();

  const credentialPair = [
    `clientId      oxy_dk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx      ${t('docs.auth.credentials.public')}`,
    `clientSecret  ${'*'.repeat(32)}  ${t('docs.auth.credentials.secret')}`,
  ].join('\n');

  return (
    <DocPage title={t('docs.auth.title')} subtitle={t('docs.auth.subtitle')}>
      <DocSection title={t('docs.auth.credentials.title')}>
        <DocP>{t('docs.auth.credentials.intro')}</DocP>
        <DocP>{t('docs.auth.credentials.pair')}</DocP>
        <DocCode code={credentialPair} />
        <Notice
          tone="warning"
          title={t('docs.auth.credentials.warningTitle')}
          paragraphs={[t('docs.auth.credentials.warningBody')]}
        />
      </DocSection>

      <DocSection title={t('docs.auth.how.title')}>
        <DocP>{t('docs.auth.how.intro')}</DocP>
        <DocCode code="Authorization: Bearer <token>" />

        <DocHeading>{t('docs.auth.how.server.title')}</DocHeading>
        <DocP>{t('docs.auth.how.server.body')}</DocP>
        <DocCode code={SERVICE_TOKEN} language="bash" />
        <DocP>{t('docs.auth.how.server.delegate')}</DocP>

        <DocHeading>{t('docs.auth.how.oauth.title')}</DocHeading>
        <DocP>{t('docs.auth.how.oauth.body')}</DocP>

        <DocHeading>{t('docs.auth.how.machine.title')}</DocHeading>
        <DocP>{t('docs.auth.how.machine.body')}</DocP>
        <DocCode code={MACHINE_REQUEST} language="bash" />
        <DocP>{t('docs.auth.how.machine.rules')}</DocP>

        <InferenceAvailabilityNotice />
      </DocSection>

      <DocSection title={t('docs.auth.scopes.title')}>
        <DocP>{t('docs.auth.scopes.intro')}</DocP>
        <View className="gap-3">
          {SCOPES.map(({ scope, key }) => (
            <View
              key={scope}
              className="flex-row flex-wrap items-start gap-3 rounded-lg bg-muted/50 p-3"
            >
              <Badge size="label-small" variant="outlined" content={scope} />
              <View className="min-w-48 flex-1">
                <RichText>{t(`docs.auth.scopes.items.${key}`)}</RichText>
              </View>
            </View>
          ))}
        </View>
      </DocSection>

      <DocSection title={t('docs.auth.rateLimits.title')}>
        <DocP>{t('docs.auth.rateLimits.intro')}</DocP>
        <DocP>{t('docs.auth.rateLimits.headers')}</DocP>
        <DocCode code={RATE_LIMIT_HEADERS} />
      </DocSection>

      <DocSection title={t('docs.auth.security.title')}>
        <Notice
          tone="warning"
          title={t('docs.auth.security.warningTitle')}
          paragraphs={[t('docs.auth.security.warningBody')]}
        />
        <View className="gap-2">
          {SECURITY_TIPS.map((tip) => (
            <View key={tip} className="flex-row items-start gap-2">
              <Text className="text-sm text-primary">•</Text>
              <View className="flex-1">
                <RichText>{t(`docs.auth.security.tips.${tip}`)}</RichText>
              </View>
            </View>
          ))}
        </View>
      </DocSection>

      <DocSection title={t('docs.auth.errors.title')}>
        <DocP>{t('docs.auth.errors.intro')}</DocP>
        <View className="gap-3">
          {ERRORS.map(({ status, key }) => (
            <View key={status} className="gap-1 rounded-lg border border-border p-3">
              <View className="flex-row items-center gap-2">
                <Badge size="label-small" variant="solid" color="error" content={status} />
                <Text className="text-sm font-medium text-foreground">
                  {t(`docs.auth.errors.${key}.name`)}
                </Text>
              </View>
              <RichText className="text-xs leading-5 text-muted-foreground">
                {t(`docs.auth.errors.${key}.body`)}
              </RichText>
            </View>
          ))}
        </View>
      </DocSection>

      <DocNextSteps
        steps={[
          { href: '/documentation/chat-completions', label: t('docs.auth.next.chat') },
          { href: '/apps', label: t('docs.auth.next.apps') },
        ]}
      />
    </DocPage>
  );
}
