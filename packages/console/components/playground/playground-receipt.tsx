import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { CodeBlock } from '@oxy.so/bloom/code';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Item } from '@oxy.so/bloom/item';
import { InlineMarkdown } from '@oxy.so/bloom/markdown';
import { Text, View } from 'react-native';

import type { PlaygroundReceiptResult, PlaygroundRun } from '@/hooks/use-playground';
import { useTranslation } from '@/lib/i18n';
import { formatCount, formatMoney } from '@/lib/money';

interface PlaygroundRunReceiptProps {
  run: PlaygroundRun;
  receipt: PlaygroundReceiptResult | undefined;
  onFetchReceipt: () => void;
  isFetchingReceipt: boolean;
  receiptError: string | undefined;
}

/**
 * What a run reports afterwards.
 *
 * Everything here is read from the RESPONSE BODY of `POST /v1/responses`, never
 * from the `X-Oxy-*` response headers. A browser can only read a response header
 * that `Access-Control-Expose-Headers` names, and when it does not, `headers.get()`
 * returns `null` silently, with no error to explain it. The body has no such
 * failure mode.
 *
 * The one number NOT from the server is the round trip, rendered BESIDE the
 * server's own latency rather than instead of it.
 */
export function PlaygroundRunReceipt({
  run,
  receipt,
  onFetchReceipt,
  isFetchingReceipt,
  receiptError,
}: PlaygroundRunReceiptProps) {
  const { t } = useTranslation();

  // One entry per figure: label, value and an optional qualifier, drawn as Bloom `Item`s.
  const runFacts: Array<{ label: string; value: string; hint?: string }> = [
    // "Model revision" because that is what it is: the edge composes
    // `<publisher>/<model>@<revision>`, naming the exact weights that ran even
    // when the request named no revision.
    { label: t('playgroundPage.receipt.modelRevision'), value: run.model },
    { label: t('playgroundPage.receipt.providerRoute'), value: run.servingProvider },
    {
      label: t('playgroundPage.receipt.routingPolicy'),
      value: `${run.routingPolicy.routingPolicyId}@${run.routingPolicy.policyVersion}`,
    },
    {
      label: t('playgroundPage.receipt.finishReason'),
      value: run.finishReason.replace(/_/g, ' '),
    },
    // TWO latencies, side by side and labelled, because they measure different
    // things. `latencyMs` is the server's, from admission to settlement, with no
    // network in it. `roundTripMs` is this browser's stopwatch around the fetch
    // and is what the person pressing Run actually waited for. Their difference
    // is not rendered: it would be a third number neither clock took. The
    // server's is conditional because the field is additive, and `NaN ms` is
    // worse than a missing row.
    ...(run.latencyMs !== undefined
      ? [
          {
            label: t('playgroundPage.receipt.serverLatency'),
            value: t('playgroundPage.receipt.milliseconds', { ms: run.latencyMs }),
            hint: t('playgroundPage.receipt.serverLatencyHint'),
          },
        ]
      : []),
    {
      label: t('playgroundPage.receipt.roundTrip'),
      value: t('playgroundPage.receipt.milliseconds', { ms: Math.round(run.roundTripMs) }),
      hint: t('playgroundPage.receipt.roundTripHint'),
    },
    ...(run.generationId !== undefined
      ? [{ label: t('playgroundPage.receipt.generation'), value: run.generationId }]
      : []),
  ];

  const found = receipt?.status === 'found' ? receipt.receipt : undefined;
  // `formatMoney` works on the digits as text. `billedAmount` is an exact decimal
  // STRING with up to twelve fractional digits, and `Number(...).toFixed(2)` would
  // render `0.000003` as `0.00`.
  const receiptFacts: Array<{ label: string; value: string; hint?: string }> =
    found === undefined
      ? []
      : [
          {
            label: found.platformFeeOnly
              ? t('playgroundPage.receipt.platformFee')
              : t('playgroundPage.receipt.billed'),
            value: formatMoney(found.billedAmount, found.currency),
            hint: found.platformFeeOnly ? t('playgroundPage.receipt.byokHint') : undefined,
          },
          { label: t('playgroundPage.receipt.outcome'), value: found.outcome },
          {
            label: t('playgroundPage.receipt.usageSource'),
            value: found.usageSource.replace(/_/g, ' '),
          },
          { label: t('playgroundPage.receipt.environment'), value: found.environment },
          {
            label: t('playgroundPage.receipt.settled'),
            value: new Date(found.settledAt).toLocaleString(),
          },
        ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('playgroundPage.receipt.title')}</CardTitle>
        <CardDescription>{t('playgroundPage.receipt.subtitle')}</CardDescription>
      </CardHeader>
      <CardBody>
        <View className="gap-6">
          {/* A code block rather than an `Item` because the point of a request id is that
              it can be copied into a support message. No language: an opaque id has no
              syntax. */}
          <CodeBlock
            code={run.requestId}
            filename={t('playgroundPage.receipt.requestId')}
            lineNumbers={false}
            wrap
          />

          <View className="flex-row flex-wrap">
            {runFacts.map((fact) => (
              <View key={fact.label} className="min-w-48 flex-1 basis-48">
                <Item
                  density="compact"
                  title={fact.label}
                  subtitle={fact.hint === undefined ? fact.value : `${fact.value} · ${fact.hint}`}
                />
              </View>
            ))}
          </View>

          {run.usage.length === 0 ? (
            <Text className="text-sm text-muted-foreground">
              {t('playgroundPage.receipt.noUnits')}
            </Text>
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
              <View className="flex-1 gap-0.5">
                <Text className="text-sm font-medium text-foreground">
                  {t('playgroundPage.receipt.billedAmount')}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  <InlineMarkdown source={t('playgroundPage.receipt.billedAmountHint')} />
                </Text>
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

            {receiptError !== undefined && <Admonition type="error">{receiptError}</Admonition>}

            {/* "No receipt" is a NORMAL answer and is deliberately not styled as an error.
                Under shadow metering (`INFERENCE_CHARGING_AUTHORIZED` unset, the default)
                no receipt is written for any request at all. The other two causes (a
                credential without `inference:usage:read`, a request belonging to another
                application) are indistinguishable by design, and the refusal arrives as
                `model_not_found`, so its message is never shown here: it would say the
                MODEL was not found, which is false. */}
            {receipt?.status === 'unavailable' && (
              <Admonition type="info">
                {`${t('playgroundPage.receipt.noReceiptTitle')} ${t('playgroundPage.receipt.noReceiptBody')}`}
              </Admonition>
            )}

            {found !== undefined && (
              <View className="gap-4">
                <View className="flex-row flex-wrap">
                  {receiptFacts.map((fact) => (
                    <View key={fact.label} className="min-w-48 flex-1 basis-48">
                      <Item
                        density="compact"
                        title={fact.label}
                        subtitle={
                          fact.hint === undefined ? fact.value : `${fact.value} · ${fact.hint}`
                        }
                      />
                    </View>
                  ))}
                </View>

                <View className="gap-2">
                  <Text className="text-xs text-muted-foreground">
                    <InlineMarkdown
                      source={t('playgroundPage.receipt.pricedUnder', {
                        version: found.priceSnapshot.priceVersionId,
                      })}
                    />
                  </Text>
                  <View className="flex-row flex-wrap gap-1.5">
                    {found.priceSnapshot.unitPrices.map((unitPrice) => (
                      <Badge
                        key={unitPrice.unit}
                        size="label-small"
                        variant="outlined"
                        content={t('modelsPage.entry.unitPrice', {
                          amount: formatMoney(unitPrice.amount, unitPrice.currency),
                          per: unitPrice.per.toLocaleString(),
                          unit: unitPrice.unit.replace(/_/g, ' '),
                        })}
                      />
                    ))}
                  </View>
                </View>
              </View>
            )}
          </View>
        </View>
      </CardBody>
    </Card>
  );
}
