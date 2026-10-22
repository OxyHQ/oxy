import { RiAlertLine } from '@oxy.so/bloom/icons/RiAlertLine';
import { RiShieldCheckLine } from '@oxy.so/bloom/icons/RiShieldCheckLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text, View } from 'react-native';
import { StatusBadge } from '@/components/account-pages/StatusBadge';
import { useTranslation } from '@/lib/i18n';
import type { ReportProvenance } from '@/lib/reporting';
import { useReportLabels } from './labels';

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
  const theme = useTheme();
  const isLedger = provenance.source === 'financial_ledger';
  const Icon = isLedger ? RiShieldCheckLine : RiAlertLine;

  return (
    <View
      className={`flex-row items-start gap-3 rounded-lg border p-4 ${
        isLedger ? 'border-border bg-muted' : 'border-dashed border-warning bg-warning-subtle'
      }`}
    >
      <View className="mt-0.5">
        <Icon size="md" fill={isLedger ? theme.colors.text : theme.colors.warning} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-sm font-medium text-foreground">
            {labels.provenanceHeadline(provenance)}
          </Text>
          <ProvenanceBadge provenance={provenance} />
        </View>
        <Text className="text-xs text-muted-foreground">
          {labels.provenanceExplanation(provenance)}
        </Text>
      </View>
    </View>
  );
}

/** The one-word version, for a heading beside a figure; it reads the same stamp. */
export function ProvenanceBadge({ provenance }: { provenance: ReportProvenance }) {
  const { t } = useTranslation();
  const isLedger = provenance.source === 'financial_ledger';
  return (
    <StatusBadge
      variant={isLedger ? 'default' : 'secondary'}
      label={t(isLedger ? 'reportKit.provenance.authoritative' : 'reportKit.provenance.eventual')}
    />
  );
}

/** The pointer from a usage screen to the money screen, and back. */
export function ProvenanceCrossReference({ provenance }: { provenance: ReportProvenance }) {
  const { t } = useTranslation();
  return (
    <Text className="text-xs text-muted-foreground">
      {t(
        provenance.source === 'financial_ledger'
          ? 'reportKit.provenance.crossLedger'
          : 'reportKit.provenance.crossTelemetry',
      )}
    </Text>
  );
}
