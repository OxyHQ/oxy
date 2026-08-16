import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { MODEL_ID_PLACEHOLDER, MODEL_REVISION_PLACEHOLDER } from '@/lib/model-reference';

/**
 * The one statement about why the samples carry a placeholder model.
 *
 * Sits beside `InferenceAvailabilityNotice` and answers a different question:
 * that one says who may call the endpoint, this one says what to write in the
 * `model` field. Both exist as components for the same reason — the fact is
 * stated once, in one wording, instead of drifting across five pages.
 */
export function ModelPlaceholderNotice({ className }: { className?: string }) {
  return (
    <div className={cn('p-4 rounded-lg bg-muted/50 border border-border', className)}>
      <p className="text-sm font-medium text-foreground">
        <code className="text-xs">{MODEL_ID_PLACEHOLDER}</code> is a placeholder
      </p>
      <p className="text-xs text-muted-foreground mt-1">
        A model is named <code className="text-xs">{MODEL_ID_PLACEHOLDER}</code>, and an exact
        version is pinned as <code className="text-xs">{MODEL_REVISION_PLACEHOLDER}</code>. Oxy
        publishes no model under those names yet, so the samples show the form rather than
        inventing an id — take the concrete value from the{' '}
        <Link to="/models" className="text-primary hover:underline">
          Models page
        </Link>{' '}
        once the catalogue is published.
      </p>
    </div>
  );
}
