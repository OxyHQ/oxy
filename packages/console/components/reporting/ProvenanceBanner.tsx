import {
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';

import { useTranslation } from '@/lib/i18n';
import type { ReportProvenance } from '@/lib/reporting';

/**
 * Where a figure came from, stated on the figure's own screen.
 *
 * It takes the response's own `{ source, consistency }` stamp rather than a
 * variant typed at the call site, so a page cannot render a usage table under a
 * ledger banner (#972 section 8): usage is telemetry written outside the ledger
 * transaction, spend is the ledger an invoice reconciles to.
 */
export function ProvenanceBanner({ provenance }: { provenance: ReportProvenance }) {
  const { t } = useTranslation();
  const kind = provenance.source === 'financial_ledger' ? 'ledger' : 'telemetry';

  return (
    <AdmonitionRoot type={kind === 'ledger' ? 'info' : 'warning'}>
      <AdmonitionRow>
        <AdmonitionIcon />
        <AdmonitionContent>
          <AdmonitionText style={{ fontWeight: '600' }}>
            {t(`reporting.provenance.${kind}Headline`)}
          </AdmonitionText>
          <AdmonitionText>{t(`reporting.provenance.${kind}Explanation`)}</AdmonitionText>
          <AdmonitionText>{t(`reporting.provenance.${kind}Cross`)}</AdmonitionText>
        </AdmonitionContent>
      </AdmonitionRow>
    </AdmonitionRoot>
  );
}
