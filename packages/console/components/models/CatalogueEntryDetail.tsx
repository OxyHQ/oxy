import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Item } from '@oxy.so/bloom/item';
import { InlineMarkdown } from '@oxy.so/bloom/markdown';
import type { ModelCatalogueEntry } from '@oxy.so/contracts';
import { Text, View } from 'react-native';

import { useTranslation } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { BadgeRow } from './BadgeRow';
import { CapabilityFlag } from './CapabilityFlag';

/**
 * Everything the catalogue serves about one model.
 *
 * Everything rendered here is a field the API serves. There is no wholesale cost,
 * no internal route id and no provider secret in `ModelCatalogueEntry` to render:
 * the customer-safe projection is built from an allow-list of columns server-side,
 * so this component has nothing unsafe available to it.
 */
export function CatalogueEntryDetail({ entry }: { entry: ModelCatalogueEntry }) {
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

  const facts: Array<{ label: string; value: string }> = [
    { label: t('modelsPage.entry.context'), value: tokens(capabilities.maxContextTokens) },
    { label: t('modelsPage.entry.maxOutput'), value: tokens(capabilities.maxOutputTokens) },
    { label: t('modelsPage.entry.input'), value: capabilities.inputModalities.join(', ') },
    { label: t('modelsPage.entry.output'), value: capabilities.outputModalities.join(', ') },
    // The UNION of every serving route's regions: the same field the region
    // filter matches on, so a customer can see what they narrowed by.
    ...(entry.regions.length > 0
      ? [{ label: t('modelsPage.entry.regions'), value: entry.regions.join(', ') }]
      : []),
    { label: t('modelsPage.entry.licence'), value: license.displayName },
    { label: t('modelsPage.entry.release'), value: provenance.releaseKind.replace(/_/g, ' ') },
    ...(entry.knowledgeCutoff !== undefined
      ? [{ label: t('modelsPage.entry.knowledgeCutoff'), value: entry.knowledgeCutoff }]
      : []),
    {
      label: t('modelsPage.entry.currentRevision'),
      value:
        entry.availableRevisions.length > 1
          ? `${entry.modelId}@${entry.currentRevision} · ${t('modelsPage.entry.revisionsPinnable', {
              count: entry.availableRevisions.length,
            })}`
          : `${entry.modelId}@${entry.currentRevision}`,
    },
  ];

  return (
    <View className="gap-4">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text selectable className="font-mono text-xs text-muted-foreground">
          {entry.modelId}
        </Text>
        {deprecation.status !== 'active' && (
          <Badge size="label-small" variant="subtle" content={deprecation.status} />
        )}
      </View>

      {entry.description !== undefined && (
        <Text className="text-sm text-muted-foreground">{entry.description}</Text>
      )}

      <View className="flex-row flex-wrap">
        {facts.map((fact) => (
          <View key={fact.label} className="min-w-48 flex-1 basis-48">
            <Item density="compact" title={fact.label} subtitle={fact.value} />
          </View>
        ))}
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
          and terms this view reports. `formatMoney` groups the digits as text; the
          amount never passes through a `Number`, so `0.000003000000` renders as
          `0.000003` rather than a `0.00` that reads like nothing is charged. The
          price VERSION id is shown because a later invoice can be re-priced against
          it; a customer disputing a charge quotes it. */}
      {pricing !== undefined && (
        <View className="gap-2">
          <Text className="text-xs text-muted-foreground">
            <InlineMarkdown
              source={t('modelsPage.entry.priceVersion', { version: pricing.priceVersionId })}
            />
          </Text>
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
        <Text className="text-xs text-muted-foreground">
          <InlineMarkdown
            source={
              deprecation.sunsetAt !== undefined
                ? t('modelsPage.entry.replacedBySunsets', {
                    model: deprecation.replacementModelReference,
                    date: new Date(deprecation.sunsetAt).toLocaleDateString(),
                  })
                : t('modelsPage.entry.replacedBy', {
                    model: deprecation.replacementModelReference,
                  })
            }
          />
        </Text>
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
