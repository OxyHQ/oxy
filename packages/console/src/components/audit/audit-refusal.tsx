import { HugeiconsIcon } from '@hugeicons/react';
import { ShieldBlockchainIcon } from '@hugeicons/core-free-icons';

/**
 * A refusal, said as a refusal.
 *
 * An audit trail is the one screen where narrowing a result to what the caller
 * may see is the wrong answer: a list covering half an account, rendered with
 * the same chrome as a whole one, reads as complete and is not. Both audit
 * routes refuse rather than narrow, and this is that refusal — it never appears
 * beside a partial list, because there is no partial list to appear beside.
 *
 * The missing permissions are NAMED. "You do not have permission" leaves a
 * customer with nothing to ask their account owner for; the permission strings
 * are the same words the Console's own member management uses.
 */
export function AuditRefusal({
  missing,
  what,
}: {
  /** The permissions the caller lacks, in the API's own vocabulary. */
  readonly missing: ReadonlyArray<string>;
  /** What is being refused, for the first sentence — "this account's trail". */
  readonly what: string;
}) {
  return (
    <div className="mx-6 my-8 max-w-2xl rounded-lg border border-border bg-muted/30 px-5 py-4">
      <div className="flex items-start gap-3">
        <HugeiconsIcon
          icon={ShieldBlockchainIcon}
          size={18}
          className="mt-0.5 shrink-0 text-muted-foreground"
        />
        <div>
          <p className="text-sm font-semibold text-foreground">You cannot read {what}.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {missing.length === 1
              ? 'It needs a permission your membership does not carry:'
              : 'It needs permissions your membership does not carry:'}{' '}
            {missing.map((permission, index) => (
              <span key={permission}>
                {index > 0 && ', '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                  {permission}
                </code>
              </span>
            ))}
            .
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            The trail is refused rather than shortened. Half a trail shown as a whole one is worse
            than none — ask an owner or admin of this account for the missing access.
          </p>
        </div>
      </div>
    </div>
  );
}
