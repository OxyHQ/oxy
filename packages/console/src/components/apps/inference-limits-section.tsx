import { useEffect, useState } from 'react';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import {
  type ApplicationInferenceLimits,
  useApplicationInferenceLimits,
  useWriteApplicationInferenceLimits,
} from '@/hooks/use-routing-policy';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getErrorMessage } from '@/lib/api-error';
import { limitsFromForm, type LimitsForm, limitsToForm } from '@/lib/inference-limits';

const FIELDS: readonly {
  readonly key: keyof ApplicationInferenceLimits;
  readonly label: string;
  readonly help: string;
}[] = [
  {
    key: 'maxConcurrentRealtimeSessions',
    label: 'Realtime sessions open at once',
    help: 'A voice session holds its slot for its whole life. Empty: no session limit.',
  },
  {
    key: 'maxConcurrentRealtimeSessionsPerCredential',
    label: 'Realtime sessions per credential',
    help: 'At most the application’s own limit. Empty: no per-credential limit.',
  },
  {
    key: 'maxConcurrentRequests',
    label: 'Internal requests in flight',
    help: 'Only for an internal Oxy relationship. Empty keeps the reviewed default.',
  },
  {
    key: 'maxRequestsPerUtcDay',
    label: 'Internal requests per UTC day',
    help: 'Only for an internal Oxy relationship. Empty keeps the reviewed default.',
  },
];

/**
 * The inference limits Oxy applies when Kaana asks to serve this application
 * (Kaana ADR 0002, Alia ADR 0017 §5). Spend is budgets, in the next tab.
 */
export function InferenceLimitsSection({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const canRead = access.can('inference:routing:read');
  const canWrite = access.can('inference:routing:write');
  const limitsQuery = useApplicationInferenceLimits(application._id, canRead);
  const writeLimits = useWriteApplicationInferenceLimits();
  const [form, setForm] = useState<LimitsForm | null>(null);

  useEffect(() => {
    if (limitsQuery.data !== undefined) setForm(limitsToForm(limitsQuery.data));
  }, [limitsQuery.data]);

  if (!canRead) return null;

  const parsed = form === null ? null : limitsFromForm(form);

  const handleSave = async () => {
    if (parsed === null || 'error' in parsed) return;
    try {
      await writeLimits.mutateAsync({ applicationId: application._id, limits: parsed.limits });
      toast.success('Inference limits saved.');
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Could not save the inference limits'));
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Inference limits</h2>
        <p className="text-sm text-muted-foreground">
          How much this application may run at once on kaana.ai. A request over a limit is refused
          with a retryable rate limit; nothing is charged.
        </p>
      </div>
      {form === null ? (
        <Skeleton.Box width="100%" height={160} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <div key={field.key} className="space-y-1">
              <Label htmlFor={`limit-${field.key}`}>{field.label}</Label>
              <Input
                id={`limit-${field.key}`}
                inputMode="numeric"
                placeholder="No limit"
                value={form[field.key]}
                disabled={!canWrite}
                onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">{field.help}</p>
            </div>
          ))}
        </div>
      )}
      {parsed !== null && 'error' in parsed && (
        <p className="text-sm text-destructive">{parsed.error}</p>
      )}
      {canWrite && (
        <Button
          size="sm"
          onClick={handleSave}
          disabled={parsed === null || 'error' in parsed || writeLimits.isPending}
        >
          Save limits
        </Button>
      )}
    </section>
  );
}
