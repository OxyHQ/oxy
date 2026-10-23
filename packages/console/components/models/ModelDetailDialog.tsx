import { Button } from '@oxy.so/bloom/button';
import { Chip } from '@oxy.so/bloom/chip';
import { Dialog } from '@oxy.so/bloom/dialog';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { InlineMarkdown } from '@oxy.so/bloom/markdown';
import { Muted } from '@oxy.so/bloom/typography';
import type { ModelCatalogueEntry } from '@oxy.so/contracts';
import { View } from 'react-native';

import { useTranslation } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';

/**
 * Everything the catalogue serves about one model, in a side sheet.
 *
 * Each row is a field of `ModelCatalogueEntry`, the customer-safe projection built
 * from an allow-list server-side: there is no wholesale cost, route id or provider
 * secret in it to render. Prices stay exact decimal strings through `formatMoney`.
 */
export function ModelDetailDialog({
  entry,
  onClose,
}: {
  entry: ModelCatalogueEntry | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (entry === null) return null;

  const { capabilities, dataPolicy, deprecation, license, provenance, pricing } = entry;
  const tokens = (count: number) => t('modelsPage.entry.tokens', { count: count.toLocaleString() });
  const flags: Array<[string, boolean]> = [
    [t('modelsPage.capability.tools'), capabilities.tools],
    [t('modelsPage.capability.vision'), capabilities.inputModalities.includes('image')],
    [t('modelsPage.capability.reasoning'), capabilities.reasoning],
    [t('modelsPage.capability.structuredOutput'), capabilities.structuredOutput],
    [t('modelsPage.capability.streaming'), capabilities.streaming],
    [t('modelsPage.capability.promptCaching'), capabilities.promptCaching],
  ];

  return (
    <Dialog
      open
      onClose={onClose}
      placement={{ base: 'bottom', md: 'right' }}
      title={entry.displayName}
      description={t('modelsPage.entry.publishedBy', { name: entry.publisher.displayName })}
      actions={[{ label: t('common.close'), color: 'cancel' }]}
    >
      <View className="gap-5">
        <Muted selectable className="font-mono text-xs">
          {entry.modelId}
        </Muted>
        {entry.description !== undefined && <Muted>{entry.description}</Muted>}

        <View className="flex-row flex-wrap gap-1.5">
          {flags
            .filter(([, supported]) => supported)
            .map(([label]) => (
              <Chip key={label} size="sm">
                {label}
              </Chip>
            ))}
        </View>

        <GroupedSection separator="line">
          <GroupedSectionItem
            title={t('modelsPage.entry.context')}
            value={tokens(capabilities.maxContextTokens)}
          />
          <GroupedSectionItem
            title={t('modelsPage.entry.maxOutput')}
            value={tokens(capabilities.maxOutputTokens)}
          />
          <GroupedSectionItem
            title={t('modelsPage.entry.input')}
            value={capabilities.inputModalities.join(', ')}
          />
          <GroupedSectionItem
            title={t('modelsPage.entry.output')}
            value={capabilities.outputModalities.join(', ')}
          />
          {entry.regions.length > 0 && (
            <GroupedSectionItem
              title={t('modelsPage.entry.regions')}
              value={entry.regions.join(', ')}
            />
          )}
          <GroupedSectionItem title={t('modelsPage.entry.licence')} value={license.displayName} />
          <GroupedSectionItem
            title={t('modelsPage.entry.release')}
            value={provenance.releaseKind.replace(/_/g, ' ')}
          />
          {entry.knowledgeCutoff !== undefined && (
            <GroupedSectionItem
              title={t('modelsPage.entry.knowledgeCutoff')}
              value={entry.knowledgeCutoff}
            />
          )}
          <GroupedSectionItem
            title={t('modelsPage.entry.currentRevision')}
            description={
              entry.availableRevisions.length > 1
                ? t('modelsPage.entry.revisionsPinnable', {
                    count: entry.availableRevisions.length,
                  })
                : undefined
            }
            value={`${entry.modelId}@${entry.currentRevision}`}
          />
        </GroupedSection>

        {entry.servingProviders.length > 0 && (
          <GroupedSection title={t('modelsPage.entry.servedBy')} separator="line">
            {entry.servingProviders.map((provider) => (
              <GroupedSectionItem
                key={provider.slug}
                title={provider.displayName}
                value={provider.regions.join(', ')}
              />
            ))}
          </GroupedSection>
        )}

        <GroupedSection title={t('modelsPage.entry.dataPolicy')} separator="line">
          <GroupedSectionItem
            title={
              dataPolicy.retainsPayloads
                ? t('modelsPage.entry.retains', { days: dataPolicy.retentionDays })
                : t('modelsPage.entry.retainsNone')
            }
          />
          <GroupedSectionItem
            title={
              dataPolicy.trainsOnCustomerData
                ? t('modelsPage.entry.trains')
                : t('modelsPage.entry.noTraining')
            }
          />
          {dataPolicy.zeroDataRetentionAvailable && (
            <GroupedSectionItem title={t('modelsPage.entry.zeroRetention')} />
          )}
          {dataPolicy.subprocessors.map((subprocessor) => (
            <GroupedSectionItem
              key={subprocessor}
              title={t('modelsPage.entry.subprocessor', { name: subprocessor })}
            />
          ))}
        </GroupedSection>

        {/* The PRIMARY route's price, with its version id: a later invoice can be
            re-priced against it, and a customer disputing a charge quotes it. */}
        {pricing !== undefined && (
          <View className="gap-2">
            <GroupedSection title={t('modelsPage.entry.price')} separator="line">
              {pricing.unitPrices.map((unitPrice) => (
                <GroupedSectionItem
                  key={unitPrice.unit}
                  title={unitPrice.unit.replace(/_/g, ' ')}
                  value={t('modelsPage.entry.perUnits', {
                    amount: formatMoney(unitPrice.amount, unitPrice.currency),
                    per: unitPrice.per.toLocaleString(),
                  })}
                />
              ))}
            </GroupedSection>
            <Muted className="text-xs">
              <InlineMarkdown
                source={t('modelsPage.entry.priceVersion', { version: pricing.priceVersionId })}
              />
            </Muted>
          </View>
        )}

        {deprecation.status !== 'active' && deprecation.replacementModelReference !== undefined && (
          <Muted className="text-xs">
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
          </Muted>
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
    </Dialog>
  );
}
