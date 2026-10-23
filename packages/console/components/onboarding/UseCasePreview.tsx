import { Card } from '@oxy.so/bloom/card';
import { Chip } from '@oxy.so/bloom/chip';
import { CodeBlock } from '@oxy.so/bloom/code';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { RiStackLine } from '@oxy.so/bloom/icons/RiStackLine';
import { Item } from '@oxy.so/bloom/item';
import { StatCards } from '@oxy.so/bloom/stat-cards';
import { UsageCard } from '@oxy.so/bloom/usage-card';
import type { ConsoleUseCaseId } from '@oxy.so/contracts/client';

import { useTranslation } from '@/lib/i18n';

const REQUEST = `curl https://api.oxy.so/v1/chat \\
  -H "Authorization: Bearer $OXY_KEY" \\
  -d '{"model": "alia", "input": "Hello"}'`;

const MODELS = ['Alia', 'Kaana Fast', 'Kaana Pro'];
const RELEASES = ['v1.4.0', 'v1.3.2', 'v1.3.1'];

/** A small illustrative composition per use case, drawn from the Bloom parts the console uses. */
export function UseCasePreview({ useCase }: { useCase: ConsoleUseCaseId }) {
  const { t } = useTranslation();

  switch (useCase) {
    case 'build-with-api':
      return <CodeBlock code={REQUEST} language="bash" lineNumbers={false} copyable={false} />;
    case 'ai-models':
      return (
        <Card>
          {MODELS.map((name, index) => (
            <Item
              key={name}
              title={name}
              subtitle={t('onboarding.preview.modelSubtitle')}
              leading={<RiRobot2Line size="md" />}
              trailing={
                index === 0 ? <Chip size="sm">{t('onboarding.preview.default')}</Chip> : null
              }
            />
          ))}
        </Card>
      );
    case 'publish-apps':
      return (
        <Card>
          {RELEASES.map((version, index) => (
            <Item
              key={version}
              title={version}
              subtitle={t('onboarding.preview.releaseSubtitle')}
              leading={<RiStackLine size="md" />}
              trailing={
                <Chip size="sm">
                  {index === 0 ? t('onboarding.preview.live') : t('onboarding.preview.previous')}
                </Chip>
              }
            />
          ))}
        </Card>
      );
    case 'billing-credits':
      return (
        <UsageCard
          title={t('onboarding.preview.credits')}
          usage={{
            max: 100,
            segments: [
              { label: t('onboarding.preview.inference'), value: 38 },
              { label: t('onboarding.preview.storage'), value: 12 },
            ],
          }}
          limits={[{ label: t('onboarding.preview.monthly'), used: 50, resets: '1 Nov' }]}
        />
      );
    case 'explore-platform':
      return (
        <StatCards
          columns={2}
          stats={[
            {
              icon: RiStackLine,
              label: t('onboarding.preview.apps'),
              value: '3',
              delta: '+1',
              deltaColor: 'lime',
            },
            {
              icon: RiRobot2Line,
              label: t('onboarding.preview.requests'),
              value: '12.4k',
              delta: '+8%',
              deltaColor: 'lime',
            },
          ]}
        />
      );
  }
}
