import {
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Muted } from '@oxy.so/bloom/typography';
import { useTranslation } from '@/lib/i18n';
import type { ReportProvenance } from '@/lib/reporting';
import { statusBadge, useReportLabels } from './labels';

/**
 * Where a figure came from, stated on the figure's own screen.
 *
 * It takes the response's own `{ source, consistency }` stamp rather than a
 * `variant` somebody types at the call site: the two literals come from the same
 * object as the numbers, so a page cannot render a usage table under a ledger
 * banner. The distinction is load-bearing (#972 §8): usage is telemetry written
 * outside the ledger transaction; spend is the ledger an invoice reconciles to.
 */
export function ProvenanceBanner({ provenance }: { provenance: ReportProvenance }) {
  const labels = useReportLabels();
  const isLedger = provenance.source === 'financial_ledger';

  return (
    <AdmonitionRoot type={isLedger ? 'info' : 'warning'}>
      <AdmonitionRow>
        <AdmonitionIcon />
        <AdmonitionContent>
          <AdmonitionText>{labels.provenanceHeadline(provenance)}</AdmonitionText>
          <AdmonitionText>{labels.provenanceExplanation(provenance)}</AdmonitionText>
          <ProvenanceBadge provenance={provenance} />
        </AdmonitionContent>
      </AdmonitionRow>
    </AdmonitionRoot>
  );
}

/** The one-word version, for a heading beside a figure; it reads the same stamp. */
export function ProvenanceBadge({ provenance }: { provenance: ReportProvenance }) {
  const { t } = useTranslation();
  const isLedger = provenance.source === 'financial_ledger';
  return (
    <Badge
      content={t(isLedger ? 'reportKit.provenance.authoritative' : 'reportKit.provenance.eventual')}
      {...statusBadge(isLedger ? 'default' : 'secondary')}
    />
  );
}

/** The pointer from a usage screen to the money screen, and back. */
export function ProvenanceCrossReference({ provenance }: { provenance: ReportProvenance }) {
  const { t } = useTranslation();
  return (
    <Muted>
      {t(
        provenance.source === 'financial_ledger'
          ? 'reportKit.provenance.crossLedger'
          : 'reportKit.provenance.crossTelemetry',
      )}
    </Muted>
  );
}
