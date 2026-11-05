import type { ApplicationInferenceLimits } from '@/hooks/use-routing-policy';

/** The largest value the API accepts for any limit (`MAX_APPLICATION_INFERENCE_LIMIT`). */
export const MAX_INFERENCE_LIMIT = 1_000_000;

/** The form's text for each limit; an empty string is an unset limit. */
export type LimitsForm = Record<keyof ApplicationInferenceLimits, string>;

export function limitsToForm(limits: ApplicationInferenceLimits): LimitsForm {
  const text = (value: number | null) => (value === null ? '' : String(value));
  return {
    maxConcurrentRealtimeSessions: text(limits.maxConcurrentRealtimeSessions),
    maxConcurrentRealtimeSessionsPerCredential: text(
      limits.maxConcurrentRealtimeSessionsPerCredential,
    ),
    maxConcurrentRequests: text(limits.maxConcurrentRequests),
    maxRequestsPerUtcDay: text(limits.maxRequestsPerUtcDay),
  };
}

/** The same rules the API and the table hold, so a mistake is shown before it is sent. */
export function limitsFromForm(
  form: LimitsForm,
): { readonly limits: ApplicationInferenceLimits } | { readonly error: string } {
  const limits = {} as { -readonly [K in keyof ApplicationInferenceLimits]: number | null };
  for (const key of Object.keys(form) as Array<keyof LimitsForm>) {
    const text = form[key].trim();
    if (text.length === 0) {
      limits[key] = null;
      continue;
    }
    if (!/^[0-9]+$/.test(text)) return { error: 'Limits are whole numbers, or empty for none.' };
    const value = Number(text);
    if (value < 1 || value > MAX_INFERENCE_LIMIT) {
      return { error: `Limits are between 1 and ${MAX_INFERENCE_LIMIT.toLocaleString('en')}.` };
    }
    limits[key] = value;
  }
  const result: ApplicationInferenceLimits = limits;
  if (
    result.maxConcurrentRealtimeSessions !== null &&
    result.maxConcurrentRealtimeSessionsPerCredential !== null &&
    result.maxConcurrentRealtimeSessionsPerCredential > result.maxConcurrentRealtimeSessions
  ) {
    return { error: 'A per-credential session limit cannot exceed the application’s.' };
  }
  return { limits: result };
}
