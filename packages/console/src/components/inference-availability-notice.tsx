import { cn } from '@/lib/utils';

/**
 * The one statement about what happens when you call the inference API today.
 *
 * It used to say `POST /v1/chat/completions` was restricted to Oxy's own
 * first-party applications, which was true of the Alia proxy that served that
 * path (issue #981) and became FALSE when the public inference edge took it
 * (#972 workstream 4). The edge authenticates an ordinary self-service
 * `oxy_sk_…` machine credential perfectly well; it refuses for an entirely
 * different reason, and a developer acts on the two differently — one says "you
 * are not allowed", the other says "nobody is served yet". The transitional
 * proxy has since been removed; this component describes only the Oxy edge.
 *
 * Sits beside `ModelPlaceholderNotice`, which answers what to write in the
 * `model` field. Both exist as components so the fact is stated once, in one
 * wording, instead of drifting across seven pages.
 */
export function InferenceAvailabilityNotice({ className }: { className?: string }) {
  return (
    <div className={cn('p-4 rounded-lg bg-muted/50 border border-border', className)}>
      <p className="text-sm font-medium text-foreground">Not serving requests yet</p>
      <p className="text-xs text-muted-foreground mt-1">
        <code className="text-xs">POST /v1/responses</code> and{' '}
        <code className="text-xs">POST /v1/chat/completions</code> accept your credential —
        an <code className="text-xs">oxy_sk_…</code> machine key or a verified service token —
        and then refuse with <code className="text-xs">service_unavailable</code>, because no
        inference data plane is connected yet. The spend held for the request is released
        before the refusal returns, so nothing is charged.
      </p>
      <p className="text-xs text-muted-foreground mt-2">
        The model catalogue is also empty, so a request naming a model is refused with{' '}
        <code className="text-xs">model_not_found</code> before it gets that far. Neither is a
        problem with your credential.
      </p>
    </div>
  );
}
