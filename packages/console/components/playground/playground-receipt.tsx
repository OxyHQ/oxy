import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { CodeBlock } from '@oxy.so/bloom/code';
import { Text, View } from 'react-native';

import { Fact } from '@/components/content/Fact';
import { Notice } from '@/components/content/Notice';
import { RichText } from '@/components/content/RichText';
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

  return (
    <View className="gap-6 rounded-lg border border-border p-4">
      <View className="gap-1">
        <Text accessibilityRole="header" className="text-sm font-semibold text-foreground">
          {t('playgroundPage.receipt.title')}
        </Text>
        <Text className="text-sm text-muted-foreground">
          {t('playgroundPage.receipt.subtitle')}
        </Text>
      </View>

      {/* A code block rather than a `Fact` because the point of a request id is that it
          can be copied into a support message. No language: an opaque id has no syntax. */}
      <CodeBlock
        code={run.requestId}
        filename={t('playgroundPage.receipt.requestId')}
        lineNumbers={false}
        wrap
      />

      <View className="flex-row flex-wrap gap-x-8 gap-y-3">
        {/* "Model revision" because that is what it is: the edge composes
            `<publisher>/<model>@<revision>`, naming the exact weights that ran even
            when the request named no revision. */}
        <Fact label={t('playgroundPage.receipt.modelRevision')} value={run.model} />
        <Fact label={t('playgroundPage.receipt.providerRoute')} value={run.servingProvider} />
        <Fact
          label={t('playgroundPage.receipt.routingPolicy')}
          value={`${run.routingPolicy.routingPolicyId}@${run.routingPolicy.policyVersion}`}
        />
        <Fact
          label={t('playgroundPage.receipt.finishReason')}
          value={run.finishReason.replace(/_/g, ' ')}
        />
        {/* TWO latencies, side by side and labelled, because they measure different
            things. `latencyMs` is the server's, from admission to settlement, with no
            network in it. `roundTripMs` is this browser's stopwatch around the fetch
            and is what the person pressing Run actually waited for. Their difference
            is not rendered: it would be a third number neither clock took. The
            server's is conditional because the field is additive, and `NaN ms` is
            worse than a missing row. */}
        {run.latencyMs !== undefined && (
          <Fact
            label={t('playgroundPage.receipt.serverLatency')}
            value={t('playgroundPage.receipt.milliseconds', { ms: run.latencyMs })}
            hint={t('playgroundPage.receipt.serverLatencyHint')}
          />
        )}
        <Fact
          label={t('playgroundPage.receipt.roundTrip')}
          value={t('playgroundPage.receipt.milliseconds', { ms: Math.round(run.roundTripMs) })}
          hint={t('playgroundPage.receipt.roundTripHint')}
        />
        {run.generationId !== undefined && (
          <Fact label={t('playgroundPage.receipt.generation')} value={run.generationId} />
        )}
      </View>

      <View className="gap-2">
        <Text className="text-xs text-muted-foreground">
          {t('playgroundPage.receipt.unitsMetered')}
        </Text>
        {run.usage.length === 0 ? (
          <Text className="text-sm text-muted-foreground">
            {t('playgroundPage.receipt.noUnits')}
          </Text>
        ) : (
          <View className="rounded-lg border border-border">
            {run.usage.map((quantity, index) => (
              <View
                key={quantity.unit}
                className={`flex-row items-center justify-between gap-4 px-3 py-2 ${
                  index === 0 ? '' : 'border-t border-border'
                }`}
              >
                <Text className="text-sm text-foreground">{quantity.unit.replace(/_/g, ' ')}</Text>
                <Text className="font-mono text-sm text-foreground">
                  {formatCount(quantity.quantity)}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>

      <View className="gap-3 border-t border-border pt-4">
        <View className="flex-row flex-wrap items-center justify-between gap-3">
          <View className="flex-1 gap-0.5">
            <Text className="text-sm font-medium text-foreground">
              {t('playgroundPage.receipt.billedAmount')}
            </Text>
            <RichText className="text-xs text-muted-foreground">
              {t('playgroundPage.receipt.billedAmountHint')}
            </RichText>
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

        {receiptError !== undefined && <Notice tone="danger" title={receiptError} />}

        {/* "No receipt" is a NORMAL answer and is deliberately not styled as an error.
            Under shadow metering (`INFERENCE_CHARGING_AUTHORIZED` unset, the default)
            no receipt is written for any request at all. The other two causes (a
            credential without `inference:usage:read`, a request belonging to another
            application) are indistinguishable by design, and the refusal arrives as
            `model_not_found`, so its message is never shown here: it would say the
            MODEL was not found, which is false. */}
        {receipt?.status === 'unavailable' && (
          <Notice
            title={t('playgroundPage.receipt.noReceiptTitle')}
            paragraphs={[t('playgroundPage.receipt.noReceiptBody')]}
          />
        )}

        {receipt?.status === 'found' && (
          <View className="gap-4">
            <View className="flex-row flex-wrap gap-x-8 gap-y-3">
              {/* `formatMoney` works on the digits as text. `billedAmount` is an exact
                  decimal STRING with up to twelve fractional digits, and
                  `Number(...).toFixed(2)` would render `0.000003` as `0.00`. */}
              <Fact
                label={
                  receipt.receipt.platformFeeOnly
                    ? t('playgroundPage.receipt.platformFee')
                    : t('playgroundPage.receipt.billed')
                }
                value={formatMoney(receipt.receipt.billedAmount, receipt.receipt.currency)}
                hint={
                  receipt.receipt.platformFeeOnly ? t('playgroundPage.receipt.byokHint') : undefined
                }
              />
              <Fact label={t('playgroundPage.receipt.outcome')} value={receipt.receipt.outcome} />
              <Fact
                label={t('playgroundPage.receipt.usageSource')}
                value={receipt.receipt.usageSource.replace(/_/g, ' ')}
              />
              <Fact
                label={t('playgroundPage.receipt.environment')}
                value={receipt.receipt.environment}
              />
              <Fact
                label={t('playgroundPage.receipt.settled')}
                value={new Date(receipt.receipt.settledAt).toLocaleString()}
              />
            </View>

            <View className="gap-2">
              <RichText className="text-xs text-muted-foreground">
                {t('playgroundPage.receipt.pricedUnder', {
                  version: receipt.receipt.priceSnapshot.priceVersionId,
                })}
              </RichText>
              <View className="flex-row flex-wrap gap-1.5">
                {receipt.receipt.priceSnapshot.unitPrices.map((unitPrice) => (
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
  );
}
