import { Admonition } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { CodeBlock } from '@oxy.so/bloom/code';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { InlineMarkdown } from '@oxy.so/bloom/markdown';
import { Muted } from '@oxy.so/bloom/typography';
import { View } from 'react-native';

import type { PlaygroundReceiptResult, PlaygroundRun } from '@/hooks/use-playground';
import { useTranslation } from '@/lib/i18n';
import { formatCount, formatMoney } from '@/lib/money';

interface PlaygroundReceiptProps {
  run: PlaygroundRun;
  receipt: PlaygroundReceiptResult | undefined;
  onFetchReceipt: () => void;
  isFetchingReceipt: boolean;
  receiptFailed: boolean;
}

/**
 * What a run reports afterwards: request id, resolved model, usage and, on request,
 * the billed amount.
 *
 * Everything in the first half is read from the response BODY of `POST /v1/responses`,
 * never from `X-Oxy-*` headers (a browser reads a header only if CORS exposes it, and
 * a missing one returns `null` without an error). The billed amount is a separate
 * call, made when the person asks: it is a second request against their own rate
 * limit and, while charging is not armed, can only answer "no receipt".
 */
export function PlaygroundReceipt({
  run,
  receipt,
  onFetchReceipt,
  isFetchingReceipt,
  receiptFailed,
}: PlaygroundReceiptProps) {
  const { t } = useTranslation();
  const ms = (value: number) => t('playgroundPage.receipt.milliseconds', { ms: value });
  const found = receipt?.status === 'found' ? receipt.receipt : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('playgroundPage.receipt.title')}</CardTitle>
        <CardDescription>{t('playgroundPage.receipt.subtitle')}</CardDescription>
      </CardHeader>
      <CardBody>
        <View className="gap-6">
          {/* A request id exists to be pasted into a support message. */}
          <CodeBlock
            code={run.requestId}
            filename={t('playgroundPage.receipt.requestId')}
            lineNumbers={false}
            wrap
          />

          <GroupedSection separator="line">
            {/* The exact revision that ran, even when the request named none. */}
            <GroupedSectionItem
              title={t('playgroundPage.receipt.modelRevision')}
              value={run.model}
            />
            <GroupedSectionItem
              title={t('playgroundPage.receipt.providerRoute')}
              value={run.servingProvider}
            />
            <GroupedSectionItem
              title={t('playgroundPage.receipt.routingPolicy')}
              value={`${run.routingPolicy.routingPolicyId}@${run.routingPolicy.policyVersion}`}
            />
            <GroupedSectionItem
              title={t('playgroundPage.receipt.finishReason')}
              value={run.finishReason.replace(/_/g, ' ')}
            />
            {/* Two latencies, never merged or subtracted: they are different clocks. */}
            {run.latencyMs !== undefined && (
              <GroupedSectionItem
                title={t('playgroundPage.receipt.serverLatency')}
                description={t('playgroundPage.receipt.serverLatencyHint')}
                value={ms(run.latencyMs)}
              />
            )}
            <GroupedSectionItem
              title={t('playgroundPage.receipt.roundTrip')}
              description={t('playgroundPage.receipt.roundTripHint')}
              value={ms(Math.round(run.roundTripMs))}
            />
            {run.generationId !== undefined && (
              <GroupedSectionItem
                title={t('playgroundPage.receipt.generation')}
                value={run.generationId}
              />
            )}
          </GroupedSection>

          {run.usage.length === 0 ? (
            <Muted>{t('playgroundPage.receipt.noUnits')}</Muted>
          ) : (
            <GroupedSection title={t('playgroundPage.receipt.unitsMetered')} separator="line">
              {run.usage.map((quantity) => (
                <GroupedSectionItem
                  key={quantity.unit}
                  title={quantity.unit.replace(/_/g, ' ')}
                  value={formatCount(quantity.quantity)}
                />
              ))}
            </GroupedSection>
          )}

          <View className="gap-3">
            <View className="flex-row flex-wrap items-center justify-between gap-3">
              <View className="min-w-48 flex-1">
                <Muted>
                  <InlineMarkdown source={t('playgroundPage.receipt.billedAmountHint')} />
                </Muted>
              </View>
              <Button
                appearance="outline"
                size="sm"
                onPress={onFetchReceipt}
                disabled={isFetchingReceipt}
                loading={isFetchingReceipt}
              >
                {isFetchingReceipt
                  ? t('playgroundPage.receipt.fetching')
                  : t('playgroundPage.receipt.fetch')}
              </Button>
            </View>

            {receiptFailed && (
              <Admonition type="error">{t('playgroundPage.receipt.failed')}</Admonition>
            )}

            {/* "No receipt" is a normal answer, not an error: under shadow metering none is
                written for any request, and a key without `inference:usage:read` or another
                application's request get the identical answer by design. The endpoint's
                own refusal says the MODEL was not found, which is false, so it is never shown. */}
            {receipt?.status === 'unavailable' && (
              <Admonition type="info">
                {`${t('playgroundPage.receipt.noReceiptTitle')} ${t('playgroundPage.receipt.noReceiptBody')}`}
              </Admonition>
            )}

            {found !== undefined && (
              <View className="gap-3">
                <GroupedSection separator="line">
                  <GroupedSectionItem
                    title={
                      found.platformFeeOnly
                        ? t('playgroundPage.receipt.platformFee')
                        : t('playgroundPage.receipt.billed')
                    }
                    description={
                      found.platformFeeOnly ? t('playgroundPage.receipt.byokHint') : undefined
                    }
                    value={formatMoney(found.billedAmount, found.currency)}
                  />
                  <GroupedSectionItem
                    title={t('playgroundPage.receipt.outcome')}
                    value={found.outcome}
                  />
                  <GroupedSectionItem
                    title={t('playgroundPage.receipt.usageSource')}
                    value={found.usageSource.replace(/_/g, ' ')}
                  />
                  <GroupedSectionItem
                    title={t('playgroundPage.receipt.environment')}
                    value={found.environment}
                  />
                  <GroupedSectionItem
                    title={t('playgroundPage.receipt.settled')}
                    value={new Date(found.settledAt).toLocaleString()}
                  />
                </GroupedSection>
                <GroupedSection
                  title={t('playgroundPage.receipt.pricedUnder', {
                    version: found.priceSnapshot.priceVersionId,
                  })}
                  separator="line"
                >
                  {found.priceSnapshot.unitPrices.map((unitPrice) => (
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
              </View>
            )}
          </View>
        </View>
      </CardBody>
    </Card>
  );
}
