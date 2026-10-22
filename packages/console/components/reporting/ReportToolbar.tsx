import { Checkbox } from '@oxy.so/bloom/checkbox';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { Muted } from '@oxy.so/bloom/typography';
import { ScrollView, View } from 'react-native';

import { useTranslation } from '@/lib/i18n';

/**
 * What a usage or spend report is broken down by, and over which scope.
 *
 * Generic over the dimension list because the two reports do not share one: usage
 * groups by the model asked for, spend by the model that served. The currency
 * switch appears only for a report that came back in more than one, since the
 * ledger never adds one currency to another.
 */
export function ReportToolbar<TDimension extends string>({
  dimensions,
  dimension,
  onDimensionChange,
  includeDescendants,
  onIncludeDescendantsChange,
  currencies = [],
  currency,
  onCurrencyChange,
}: {
  dimensions: ReadonlyArray<{ value: TDimension; label: string }>;
  dimension: TDimension;
  onDimensionChange: (dimension: TDimension) => void;
  includeDescendants: boolean;
  onIncludeDescendantsChange: (include: boolean) => void;
  currencies?: ReadonlyArray<string>;
  currency?: string;
  onCurrencyChange?: (currency: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <View className="flex-row flex-wrap items-center gap-x-6 gap-y-3">
      <View className="max-w-full gap-2 sm:flex-row sm:items-center sm:gap-3">
        <Muted>{t('reporting.breakdown')}</Muted>
        {/* Four options are wider than a phone: the control scrolls inside itself. */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <SegmentedControl
            type="radio"
            size="sm"
            label={t('reporting.breakdown')}
            value={dimension}
            onValueChange={(next: string) => onDimensionChange(next as TDimension)}
          >
            {dimensions.map((entry) => (
              <SegmentedControlItem key={entry.value} value={entry.value}>
                <SegmentedControlItemText>{entry.label}</SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </ScrollView>
      </View>

      {currencies.length > 1 && currency !== undefined && onCurrencyChange !== undefined ? (
        <SegmentedControl
          type="radio"
          size="sm"
          label={t('reporting.currency')}
          value={currency}
          onValueChange={onCurrencyChange}
        >
          {currencies.map((code) => (
            <SegmentedControlItem key={code} value={code}>
              <SegmentedControlItemText>{code}</SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      ) : null}

      <Checkbox
        checked={includeDescendants}
        onCheckedChange={onIncludeDescendantsChange}
        label={t('reporting.includeDescendants')}
      />
    </View>
  );
}
