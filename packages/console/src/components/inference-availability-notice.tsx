import { cn } from '@/lib/utils';

/**
 * The one statement about who may call `POST /v1/chat/completions` today.
 *
 * The endpoint is gated to callers acting for a platform-trusted (first-party /
 * internal) application (issue #981), which means every credential a developer
 * can obtain for themselves — a signed-in user's access token, or a service
 * token minted from a self-service application credential — is refused. Until
 * the metered public endpoint of #972 workstream 4 exists, that is the whole
 * story, and every page that shows a request against this endpoint says it in
 * these exact words rather than in five drifting paraphrases.
 */
export function InferenceAvailabilityNotice({ className }: { className?: string }) {
  return (
    <div className={cn('p-4 rounded-lg bg-muted/50 border border-border', className)}>
      <p className="text-sm font-medium text-foreground">Not publicly available yet</p>
      <p className="text-xs text-muted-foreground mt-1">
        <code className="text-xs">POST /v1/chat/completions</code> is restricted to Oxy's own
        first-party applications. A signed-in user's access token is refused, and so is a service
        token minted from a self-service application credential.
      </p>
    </div>
  );
}
