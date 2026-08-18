import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon } from '@hugeicons/core-free-icons';
import type { PlaygroundReceiptResult, PlaygroundRun } from '@/hooks/use-playground';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ui/code-block';
import { formatCount, formatMoney } from '@/lib/money';

/**
 * What a run reports afterwards (issue #972, workstream 9).
 *
 * Everything here is read from the RESPONSE BODY of `POST /v1/responses`, never
 * from the `X-Oxy-*` response headers. The headers carry the same facts, but a
 * browser can only read a response header that
 * `Access-Control-Expose-Headers` names — and when it does not, `headers.get()`
 * returns `null` silently, with no error and nothing in a network log to explain
 * it. The body has no such failure mode. (The headers are now exposed too, for
 * the OpenAI-compat surface whose body deliberately carries none of these
 * fields.)
 *
 * The one number NOT from the server is the round trip, which is rendered BESIDE
 * the server's own latency rather than instead of it — see the comment on the two
 * `Fact`s below for why neither one substitutes for the other.
 */

/** The presentation idiom the Models page uses, so the two read alike. */
function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
      <p className="text-sm font-medium text-foreground">{value}</p>
      {hint !== undefined && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

export function PlaygroundRunReceipt({
  run,
  receipt,
  onFetchReceipt,
  isFetchingReceipt,
  receiptError,
}: {
  run: PlaygroundRun;
  receipt: PlaygroundReceiptResult | undefined;
  onFetchReceipt: () => void;
  isFetchingReceipt: boolean;
  receiptError: string | undefined;
}) {
  return (
    <div className="space-y-6 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">This run</h2>
        <p className="text-sm text-muted-foreground">
          Read from the response body, so every field here is what the server said it served.
        </p>
      </div>

      {/*
        A CodeBlock rather than a `Fact` because the entire point of a request id
        is that it can be copied into a support message; rendering it as text you
        have to select by hand defeats it. No `language` is named — an opaque id
        has no syntax, and `BundledLanguage` has no plaintext member.
      */}
      <div>
        <CodeBlock code={run.requestId}>
          <CodeBlockHeader>
            <CodeBlockTitle>Request ID</CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton />
            </CodeBlockActions>
          </CodeBlockHeader>
        </CodeBlock>
      </div>

      <div className="flex flex-wrap gap-8">
        {/*
          Labelled "Model revision" because that is what it is: the edge composes
          `<publisher>/<model>@<revision>` through `composeModelReference`, so this
          names the exact weights that ran even when the request named no revision.
        */}
        <Fact label="Model revision" value={run.model} />
        <Fact label="Provider route" value={run.servingProvider} />
        <Fact
          label="Routing policy"
          value={`${run.routingPolicy.routingPolicyId}@${run.routingPolicy.policyVersion}`}
        />
        <Fact label="Finish reason" value={run.finishReason.replace(/_/g, ' ')} />
        {/*
          TWO latencies, side by side and labelled, because they measure different
          things and neither one is the other's approximation.

          `latencyMs` is the server's: the edge starts a monotonic clock when it
          receives the request, before authentication, and stops it after the hold
          is settled. It contains no network. `roundTripMs` is this browser's
          stopwatch around the `fetch`, so it additionally contains DNS, TLS, both
          network legs and the JSON parse — and it is the only one that describes
          what the person who pressed Run actually waited for.

          Collapsing them into one figure would destroy the only number that
          measures Oxy; showing the server's alone would hide the wait the user
          experienced. Their difference is not rendered either: it would be a
          third number neither clock took.

          The server's is conditional because the field is additive — a Console
          deployed ahead of the API reads `undefined`, and `NaN ms` is worse than
          a missing row.
        */}
        {run.latencyMs !== undefined && (
          <Fact
            label="Server latency"
            value={`${run.latencyMs} ms`}
            hint="measured by Oxy, admission to settlement"
          />
        )}
        <Fact
          label="Round trip"
          value={`${Math.round(run.roundTripMs)} ms`}
          hint="measured in your browser, network included"
        />
        {run.generationId !== undefined && (
          <Fact label="Generation" value={run.generationId} />
        )}
      </div>

      <div>
        <p className="text-xs text-muted-foreground mb-2">Units metered</p>
        {run.usage.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The response reported no metered units.
          </p>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {run.usage.map((quantity) => (
              <div
                key={quantity.unit}
                className="flex items-center justify-between gap-4 px-3 py-2"
              >
                <span className="text-sm text-foreground">
                  {quantity.unit.replace(/_/g, ' ')}
                </span>
                <span className="text-sm font-mono text-foreground">
                  {formatCount(quantity.quantity)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">Billed amount</p>
            <p className="text-xs text-muted-foreground">
              A second call to <code className="font-mono">GET /v1/generations</code> with the
              same credential.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onFetchReceipt}
            disabled={isFetchingReceipt}
          >
            {isFetchingReceipt ? 'Fetching…' : 'Fetch receipt'}
          </Button>
        </div>

        {receiptError !== undefined && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 p-3">
            <HugeiconsIcon icon={Alert02Icon} size={16} className="mt-0.5 text-destructive" />
            <p className="text-sm text-destructive">{receiptError}</p>
          </div>
        )}

        {/*
          "No receipt" is a NORMAL answer and is deliberately not styled as an
          error. Under shadow metering — `INFERENCE_CHARGING_AUTHORIZED` unset,
          which is the default — no receipt is written for any request at all, so
          this is the expected outcome today. The other two causes (a credential
          without `inference:usage:read`, a request belonging to another
          application) are indistinguishable by design, and the refusal arrives as
          `model_not_found` because the closed error vocabulary has no generic
          "not found" — so its message is never shown here. It would say the MODEL
          was not found, which is false.
        */}
        {receipt?.status === 'unavailable' && (
          <div className="rounded-lg border border-border p-3">
            <p className="text-sm text-foreground">No receipt was written for this request.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Expected while charging is not armed: requests are metered and priced, but no
              receipt, reservation or ledger entry is written. A credential without the
              <code className="font-mono"> inference:usage:read </code> scope also gets this
              answer, and the two are deliberately indistinguishable.
            </p>
          </div>
        )}

        {receipt?.status === 'found' && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-8">
              {/*
                `formatMoney` works on the digits as text. `billedAmount` is an
                exact decimal STRING with up to twelve fractional digits, and
                `Number(billedAmount).toFixed(2)` would render a per-request charge
                of `0.000003` as `0.00` — a wrong figure that still looks like
                money.
              */}
              <Fact
                label={receipt.receipt.platformFeeOnly ? 'Platform fee' : 'Billed'}
                value={formatMoney(receipt.receipt.billedAmount, receipt.receipt.currency)}
                hint={
                  receipt.receipt.platformFeeOnly
                    ? 'BYOK request — your provider billed you for the tokens directly'
                    : undefined
                }
              />
              <Fact label="Outcome" value={receipt.receipt.outcome} />
              <Fact
                label="Usage source"
                value={receipt.receipt.usageSource.replace(/_/g, ' ')}
              />
              <Fact label="Environment" value={receipt.receipt.environment} />
              <Fact
                label="Settled"
                value={new Date(receipt.receipt.settledAt).toLocaleString()}
              />
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-2">
                Priced under version{' '}
                <code className="font-mono">{receipt.receipt.priceSnapshot.priceVersionId}</code>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {receipt.receipt.priceSnapshot.unitPrices.map((unitPrice) => (
                  <Badge key={unitPrice.unit} variant="outline" className="text-xs">
                    {formatMoney(unitPrice.amount, unitPrice.currency)} per{' '}
                    {unitPrice.per.toLocaleString()} {unitPrice.unit.replace(/_/g, ' ')}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
