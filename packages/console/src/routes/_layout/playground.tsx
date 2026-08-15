import { Link, createFileRoute } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon, SparklesIcon } from '@hugeicons/core-free-icons';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';

export const Route = createFileRoute('/_layout/playground')({
  component: PlaygroundPage,
});

/**
 * The playground sends nothing.
 *
 * It used to POST the signed-in user's own access token to
 * `${config.oxyUrl}/v1/chat/completions`, which is exactly the caller that
 * endpoint now refuses (issue #981) — so a chat surface here would compose a
 * request, fire it, and render a 403 as an opaque failure. Stating the
 * restriction is the honest version of the same information, and it is why the
 * composer, the model settings and the streaming reader are gone rather than
 * disabled: none of them can run, and a disabled input still implies that
 * something here might work.
 *
 * What replaces this is #972 workstream 4, the metered public inference edge.
 * That lane authenticates a credential and an environment rather than an
 * ambient session (ADR 0010), so the playground it needs is a different screen,
 * not this one with the fetch re-enabled.
 */
function PlaygroundPage() {
  return (
    <div className="flex-1 bg-background">
      <div className="px-6 py-6 border-b border-border">
        <h1 className="text-2xl font-semibold text-foreground">Playground</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Try the inference API from the browser
        </p>
      </div>

      <div className="px-6 py-20">
        <div className="max-w-lg mx-auto text-center">
          <HugeiconsIcon
            icon={SparklesIcon}
            size={48}
            className="mx-auto mb-4 text-muted-foreground/50"
          />
          <InferenceAvailabilityNotice className="text-left" />
          <p className="text-sm text-muted-foreground mt-4">
            This page sends no requests while that is the case.
          </p>
          <Link
            to="/documentation/chat-completions"
            className="flex items-center justify-center gap-1 mt-6 text-sm text-primary hover:underline"
          >
            Read the Chat Completions reference
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
          </Link>
        </div>
      </div>
    </div>
  );
}
