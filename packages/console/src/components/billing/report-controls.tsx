import type { ReportRangeDays } from '@/lib/reporting';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { REPORT_RANGE_DAYS } from '@/lib/reporting';

/**
 * The window and the grouping, for a usage or a spend report.
 *
 * Generic over the dimension vocabulary because the two reports do NOT share
 * one: usage groups by `requestedModel`, spend by `resolvedModel`, since a
 * receipt records the route that actually served and was priced. Passing one
 * list where the other belongs is a type error rather than a query the API
 * refuses.
 *
 * At least one dimension always stays selected — the API's `groupBy` has a
 * minimum of one, so an empty selection would produce a 400 the customer has no
 * way to read as "you turned everything off".
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">Period</span>
        <div className="flex gap-1">
          {REPORT_RANGE_DAYS.map((days) => (
            <Button
              key={days}
              variant={rangeDays === days ? 'default' : 'ghost'}
              size="sm"
              onClick={() => onRangeDaysChange(days)}
            >
              {days}d
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">Group by</span>
        <div className="flex flex-wrap gap-1.5">
          {dimensions.map((dimension) => {
            const isSelected = selected.includes(dimension);
            const isLastSelected = isSelected && selected.length === 1;
            return (
              <button
                key={dimension}
                type="button"
                onClick={() => toggle(dimension)}
                disabled={isLastSelected}
                aria-pressed={isSelected}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  isSelected
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:text-foreground',
                  isLastSelected && 'cursor-not-allowed opacity-70'
                )}
                title={
                  isLastSelected ? 'A report is always grouped by at least one dimension' : undefined
                }
              >
                {dimensionLabel(dimension)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
