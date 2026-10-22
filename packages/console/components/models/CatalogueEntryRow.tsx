import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import type { ModelCatalogueEntry } from '@oxy.so/contracts';
import { Text, View } from 'react-native';

import { Fact } from '@/components/content/Fact';
import { RichText } from '@/components/content/RichText';
import { useTranslation } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { BadgeRow } from './BadgeRow';
import { CapabilityFlag } from './CapabilityFlag';

interface CatalogueEntryRowProps {
  entry: ModelCatalogueEntry;
  isLast: boolean;
}

/**
 * One catalogue entry.
 *
 * Everything rendered here is a field the API serves. There is no wholesale cost,
 * no internal route id and no provider secret in `ModelCatalogueEntry` to render:
 * the customer-safe projection is built from an allow-list of columns server-side,
 * so this component has nothing unsafe available to it.
 */
export function CatalogueEntryRow({ entry, isLast }: CatalogueEntryRowProps) {
  const { t } = useTranslation();
  const { capabilities, dataPolicy, deprecation, license, provenance, pricing } = entry;
  const tokens = (count: number) => t('modelsPage.entry.tokens', { count: count.toLocaleString() });

  const dataPolicyBadges = [
    dataPolicy.retainsPayloads
      ? t('modelsPage.entry.retains', { days: dataPolicy.retentionDays })
      : t('modelsPage.entry.retainsNone'),
    dataPolicy.trainsOnCustomerData
      ? t('modelsPage.entry.trains')
      : t('modelsPage.entry.noTraining'),
    ...(dataPolicy.zeroDataRetentionAvailable ? [t('modelsPage.entry.zeroRetention')] : []),
    ...dataPolicy.subprocessors.map((subprocessor) =>
      t('modelsPage.entry.subprocessor', { name: subprocessor }),
    ),
  ];

  return (
    <View className={`gap-4 py-6 ${isLast ? '' : 'border-b border-border'}`}>
      <View className="flex-row flex-wrap items-start justify-between gap-3">
        <View className="gap-0.5">
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-medium text-foreground">{entry.displayName}</Text>
            {deprecation.status !== 'active' && (
              <Badge size="label-small" variant="subtle" content={deprecation.status} />
            )}
          </View>
          <Text selectable className="font-mono text-xs text-muted-foreground">
            {entry.modelId}
          </Text>
          <Text className="mt-1 text-xs text-muted-foreground">
            {t('modelsPage.entry.publishedBy', { name: entry.publisher.displayName })}
          </Text>
        </View>
        <View className="gap-0.5 sm:items-end">
          <Text className="text-xs text-muted-foreground">
            {t('modelsPage.entry.currentRevision')}
          </Text>
          <Text selectable className="font-mono text-xs text-foreground">
            {`${entry.modelId}@${entry.currentRevision}`}
          </Text>
          {entry.availableRevisions.length > 1 && (
            <Text className="text-xs text-muted-foreground">
              {t('modelsPage.entry.revisionsPinnable', { count: entry.availableRevisions.length })}
            </Text>
          )}
        </View>
      </View>

      {entry.description !== undefined && (
        <Text className="text-sm text-muted-foreground">{entry.description}</Text>
      )}

      <View className="flex-row flex-wrap gap-x-8 gap-y-3">
        <Fact label={t('modelsPage.entry.context')} value={tokens(capabilities.maxContextTokens)} />
        <Fact
          label={t('modelsPage.entry.maxOutput')}
          value={tokens(capabilities.maxOutputTokens)}
        />
        <Fact label={t('modelsPage.entry.input')} value={capabilities.inputModalities.join(', ')} />
        <Fact
          label={t('modelsPage.entry.output')}
          value={capabilities.outputModalities.join(', ')}
        />
        {/* The UNION of every serving route's regions: the same field the region
            filter matches on, so a customer can see what they narrowed by. */}
        {entry.regions.length > 0 && (
          <Fact label={t('modelsPage.entry.regions')} value={entry.regions.join(', ')} />
        )}
        <Fact label={t('modelsPage.entry.licence')} value={license.displayName} />
        <Fact
          label={t('modelsPage.entry.release')}
          value={provenance.releaseKind.replace(/_/g, ' ')}
        />
        {entry.knowledgeCutoff !== undefined && (
          <Fact label={t('modelsPage.entry.knowledgeCutoff')} value={entry.knowledgeCutoff} />
        )}
      </View>

      <View className="flex-row flex-wrap items-center gap-x-4 gap-y-2">
        <CapabilityFlag label={t('modelsPage.capability.tools')} supported={capabilities.tools} />
        <CapabilityFlag
          label={t('modelsPage.capability.vision')}
          supported={capabilities.inputModalities.includes('image')}
        />
        <CapabilityFlag
          label={t('modelsPage.capability.reasoning')}
          supported={capabilities.reasoning}
        />
        <CapabilityFlag
          label={t('modelsPage.capability.structuredOutput')}
          supported={capabilities.structuredOutput}
        />
        <CapabilityFlag
          label={t('modelsPage.capability.streaming')}
          supported={capabilities.streaming}
        />
        <CapabilityFlag
          label={t('modelsPage.capability.promptCaching')}
          supported={capabilities.promptCaching}
        />
      </View>

      {entry.servingProviders.length > 0 && (
        <View className="gap-2">
          <Text className="text-xs text-muted-foreground">{t('modelsPage.entry.servedBy')}</Text>
          <BadgeRow
            items={entry.servingProviders.map((provider) =>
              provider.regions.length > 0
                ? `${provider.displayName} · ${provider.regions.join(', ')}`
                : provider.displayName,
            )}
          />
        </View>
      )}

      <View className="gap-2">
        <Text className="text-xs text-muted-foreground">{t('modelsPage.entry.dataPolicy')}</Text>
        <BadgeRow items={dataPolicyBadges} />
      </View>

      {/* The published price for the PRIMARY route, the same route whose data policy
          and terms this row reports. `formatMoney` groups the digits as text; the
          amount never passes through a `Number`, so `0.000003000000` renders as
          `0.000003` rather than a `0.00` that reads like nothing is charged. The
          price VERSION id is shown because a later invoice can be re-priced against
          it; a customer disputing a charge quotes it. */}
      {pricing !== undefined && (
        <View className="gap-2">
          <RichText className="text-xs text-muted-foreground">
            {t('modelsPage.entry.priceVersion', { version: pricing.priceVersionId })}
          </RichText>
          <BadgeRow
            items={pricing.unitPrices.map((unitPrice) =>
              t('modelsPage.entry.unitPrice', {
                amount: formatMoney(unitPrice.amount, unitPrice.currency),
                per: unitPrice.per.toLocaleString(),
                unit: unitPrice.unit.replace(/_/g, ' '),
              }),
            )}
          />
        </View>
      )}

      {deprecation.status !== 'active' && deprecation.replacementModelReference !== undefined && (
        <RichText className="text-xs text-muted-foreground">
          {deprecation.sunsetAt !== undefined
            ? t('modelsPage.entry.replacedBySunsets', {
                model: deprecation.replacementModelReference,
                date: new Date(deprecation.sunsetAt).toLocaleDateString(),
              })
            : t('modelsPage.entry.replacedBy', { model: deprecation.replacementModelReference })}
        </RichText>
      )}

      {entry.modelCardUrl !== undefined && (
        <View className="items-start">
          <Button
            appearance="plain"
            tone="accent"
            size="sm"
            href={entry.modelCardUrl}
            target="_blank"
            rel="noreferrer"
          >
            {t('modelsPage.entry.modelCard')}
          </Button>
        </View>
      )}
    </View>
  );
}
