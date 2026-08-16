import { HugeiconsIcon } from '@hugeicons/react';
import { Alert01Icon, CheckmarkBadge01Icon } from '@hugeicons/core-free-icons';
import type { ReportProvenance } from '@/lib/reporting';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { provenanceExplanation, provenanceHeadline } from '@/lib/reporting';

/**
 * Where a figure came from, stated on the figure's own screen.
 *
 * ## Why this takes the response and not a prop
 *
 * `provenance` is the `{ source, consistency }` pair the API sends on every
 * reporting response, as required literals that a serializer cannot omit or
 * swap. Passing the response's own stamp through — rather than a `variant`
 * somebody types at the call site — is what makes it impossible for a page to
 * render a usage table under a ledger banner: the two literals come from the
 * same object as the numbers.
 *
 * The distinction is load-bearing rather than decorative. A customer comparing a
 * usage chart against a billed amount is comparing two different tables: usage
 * is telemetry written outside the ledger transaction and can lag or miss a
 * request entirely, while spend is the ledger and is what an invoice reconciles
 * against. #972 §8 exists because those two numbers are different, and blurring
 * them is the failure it names.
 */
export function ProvenanceBanner({
  provenance,
  className,
}: {
  provenance: ReportProvenance;
  className?: string;
}) {
  const isLedger = provenance.source === 'financial_ledger';

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border p-4',
        // Two visibly different surfaces, not two shades of one: an
        // authoritative figure gets a solid border, an eventually consistent one
        // a dashed border and a warning tone, so the two are told apart at a
        // glance and not only by reading.
        isLedger
          ? 'border-border bg-muted/40'
          : 'border-dashed border-amber-500/40 bg-amber-500/5',
        className
      )}
    >
      <HugeiconsIcon
        icon={isLedger ? CheckmarkBadge01Icon : Alert01Icon}
        size={18}
        className={cn('mt-0.5 shrink-0', isLedger ? 'text-foreground' : 'text-amber-600')}
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-foreground">{provenanceHeadline(provenance)}</p>
          <ProvenanceBadge provenance={provenance} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{provenanceExplanation(provenance)}</p>
      </div>
    </div>
  );
}

/**
 * The one-word version, for a heading that sits beside a figure.
 *
 * Uses the same two literals, so a badge can never disagree with the banner
 * above it.
 */
export function ProvenanceBadge({ provenance }: { provenance: ReportProvenance }) {
  const isLedger = provenance.source === 'financial_ledger';
  return (
    <Badge variant={isLedger ? 'default' : 'secondary'}>
      {isLedger ? 'Authoritative' : 'Eventually consistent'}
    </Badge>
  );
}

/**
 * The pointer from a usage screen to the money screen, and back.
 *
 * A customer who lands on units and wants a bill should not have to guess where
 * it lives, and the sentence that sends them there is the same sentence in both
 * directions rather than two paraphrases.
 */
export function ProvenanceCrossReference({
  provenance,
  className,
}: {
  provenance: ReportProvenance;
  className?: string;
}) {
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      {provenance.source === 'financial_ledger'
        ? 'Request and token counts for the same period are under Usage. They are telemetry, not a bill, and the two will not always agree.'
        : 'What you were actually charged is under Billing → Spend. It is read from the financial ledger, and it is the figure an invoice reconciles against.'}
    </p>
  );
}
