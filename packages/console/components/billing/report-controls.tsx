import { Chip } from '@oxy.so/bloom/chip';
import { Field } from '@oxy.so/bloom/field';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { View } from 'react-native';
import { useTranslation } from '@/lib/i18n';
import { REPORT_RANGE_DAYS, type ReportRangeDays } from '@/lib/reporting';

/**
 * The window and the grouping, for a usage or a spend report.
 *
 * Generic over the dimension vocabulary because the two reports do NOT share
 * one: usage groups by `requestedModel`, spend by `resolvedModel`. At least one
 * dimension always stays selected — the API's `groupBy` has a minimum of one, so
 * an empty selection would be a 400 the customer cannot read.
 */
export function ReportControls<TDimension extends string>({
  rangeDays,
  onRangeDaysChange,
  dimensions,
  selected,
  onSelectedChange,
  dimensionLabel,
}: {
  rangeDays: ReportRangeDays;
  onRangeDaysChange: (days: ReportRangeDays) => void;
  dimensions: ReadonlyArray<TDimension>;
  selected: ReadonlyArray<TDimension>;
  onSelectedChange: (next: ReadonlyArray<TDimension>) => void;
  dimensionLabel: (dimension: TDimension) => string;
}) {
  const { t } = useTranslation();

  const toggle = (dimension: TDimension) => {
    if (selected.includes(dimension)) {
      if (selected.length === 1) {
        return;
      }
      onSelectedChange(selected.filter((entry) => entry !== dimension));
      return;
    }
    // Keep the caller's canonical order rather than click order, so the columns
    // do not rearrange themselves as the customer adds dimensions.
    onSelectedChange(dimensions.filter((entry) => entry === dimension || selected.includes(entry)));
  };

  return (
    <View className="gap-4">
      <Field label={t('reportKit.period')}>
        <RangePicker value={rangeDays} onChange={onRangeDaysChange} />
      </Field>

      <Field label={t('reportKit.groupBy')}>
        <View className="flex-row flex-wrap gap-1.5">
          {dimensions.map((dimension) => {
            const isSelected = selected.includes(dimension);
            const isLastSelected = isSelected && selected.length === 1;
            return (
              <Chip
                key={dimension}
                role="checkbox"
                checked={isSelected}
                disabled={isLastSelected}
                onPress={() => toggle(dimension)}
                accessibilityLabel={
                  isLastSelected
                    ? `${dimensionLabel(dimension)}. ${t('reportKit.groupByMinimum')}`
                    : dimensionLabel(dimension)
                }
              >
                {dimensionLabel(dimension)}
              </Chip>
            );
          })}
        </View>
      </Field>
    </View>
  );
}

/** The 7 / 30 / 90 day picker shared by the reports. */
export function RangePicker({
  value,
  onChange,
}: {
  value: ReportRangeDays;
  onChange: (days: ReportRangeDays) => void;
}) {
  const { t } = useTranslation();
  return (
    <SegmentedControl
      type="radio"
      size="sm"
      label={t('reportKit.period')}
      value={String(value)}
      onValueChange={(next: string) => onChange(Number(next) as ReportRangeDays)}
    >
      {REPORT_RANGE_DAYS.map((days) => (
        <SegmentedControlItem key={days} value={String(days)}>
          <SegmentedControlItemText>
            {t('reportKit.days', { count: days })}
          </SegmentedControlItemText>
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
