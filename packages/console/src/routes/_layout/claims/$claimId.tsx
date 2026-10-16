import { Link, createFileRoute } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { toast } from '@oxy.so/bloom/toast';
import type {
  ContentClaimCounterNoticeView,
  ContentClaimDetailView,
  ContentClaimTargetView,
} from '@oxy.so/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  ClaimDeadlineBadge,
  ClaimStateBadge,
  ClaimsRefusal,
} from '@/components/claims/claim-badges';
import {
  useAddClaimNote,
  useAttachClaimTargets,
  useBlockClaimTargets,
  useClaimTargetPreview,
  useContentClaim,
  useContentClaimsAccess,
  useRecordCounterNotice,
  useReinstateClaim,
  useRejectClaim,
  useStartClaimReview,
  useUpholdClaim,
} from '@/hooks/use-content-claims';
import { getErrorMessage, isPermissionRefused } from '@/lib/api-error';
import {
  CLAIM_EVENT_LABELS,
  CLAIM_KIND_LABELS,
  CLAIM_STATE_LABELS,
  CLAIMANT_RELATIONSHIP_LABELS,
  TARGET_RESOLUTION_LABELS,
  canAttach,
  canBlock,
  canRecordCounterNotice,
  canReinstate,
  canReject,
  canStartReview,
  canUphold,
  isBlockableTarget,
  parseFileIds,
  previewKind,
} from '@/lib/content-claims';

/**
 * One content claim (ADR 0042 D10): the claimant's statement, what it names,
 * the actions its state allows, and the audit trail.
 *
 * The API decides every transition (a conditional write answering 409 when
 * another reviewer moved the claim first); the buttons offered here only follow
 * the same state machine. Every action's answer is the claim as it now stands.
 */
export const Route = createFileRoute('/_layout/claims/$claimId')({
  component: ContentClaimPage,
});

function ContentClaimPage() {
  const { claimId } = Route.useParams();
  const access = useContentClaimsAccess();
  const canReview = access.data?.canReview === true;
  const query = useContentClaim(claimId, canReview);

  if (access.isLoading || (canReview && query.isLoading)) {
    return (
      <div className="flex-1 bg-background flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!canReview || (query.isError && isPermissionRefused(query.error))) {
    return (
      <ScrollArea className="flex-1 bg-background">
        <ClaimsRefusal />
      </ScrollArea>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="flex-1 bg-background flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">This claim could not be loaded.</p>
        <Link to="/claims" className="text-sm text-foreground underline underline-offset-4">
          Back to content claims
        </Link>
      </div>
    );
  }

  return <ClaimDetail claim={query.data} />;
}

function ClaimDetail({ claim }: { claim: ContentClaimDetailView }) {
  const [selected, setSelected] = useState<string[]>([]);
  const blockable = claim.targets.filter(isBlockableTarget);
  const offerBlock = canBlock(claim.state) && blockable.length > 0;

  return (
    <ScrollArea className="flex-1 bg-background">
      <div className="px-6 pt-6 pb-4 border-b border-border space-y-2">
        <Link to="/claims" className="text-sm text-muted-foreground underline underline-offset-4">
          Content claims
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold text-foreground font-mono">{claim.reference}</h1>
          <ClaimStateBadge state={claim.state} />
          <ClaimDeadlineBadge claim={claim} />
        </div>
        <p className="text-sm text-muted-foreground">
          {CLAIM_KIND_LABELS[claim.kind]} · {CLAIMANT_RELATIONSHIP_LABELS[claim.relationship]} ·
          received {new Date(claim.receivedAt).toLocaleString()}
          {claim.closedAt ? ` · closed ${new Date(claim.closedAt).toLocaleString()}` : ''}
          {claim.submittedByUserId ? ` · submitted signed in as ${claim.submittedByUserId}` : ''}
        </p>
        {claim.deadlineAt && (
          <p className="text-sm text-muted-foreground">
            A GDPR erasure request: answer it by {new Date(claim.deadlineAt).toLocaleDateString()}.
          </p>
        )}
      </div>

      <div className="px-6 py-6 space-y-8 max-w-5xl">
        <ClaimActions
          claim={claim}
          selected={selected}
          offerBlock={offerBlock}
          onBlocked={() => setSelected([])}
        />

        <Section title="Claimant">
          {claim.claimant === null ? (
            <p className="text-sm text-muted-foreground">
              The claimant's identity and statement were erased at the end of their retention period
              {claim.claimantExpiresAt
                ? ` (${new Date(claim.claimantExpiresAt).toLocaleDateString()})`
                : ''}
              .
            </p>
          ) : (
            <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{claim.claimant.name}</dd>
              <dt className="text-muted-foreground">Email</dt>
              <dd>{claim.claimant.email}</dd>
              {claim.claimant.organization && (
                <>
                  <dt className="text-muted-foreground">Organization</dt>
                  <dd>{claim.claimant.organization}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Signature</dt>
              <dd>{claim.claimant.signature}</dd>
              {claim.claimant.originalWorkUrl && (
                <>
                  <dt className="text-muted-foreground">Original work</dt>
                  <dd className="break-all">
                    <a
                      href={claim.claimant.originalWorkUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="underline underline-offset-4"
                    >
                      {claim.claimant.originalWorkUrl}
                    </a>
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">Statement</dt>
              <dd className="whitespace-pre-wrap">{claim.claimant.description}</dd>
              {claim.claimantExpiresAt && (
                <>
                  <dt className="text-muted-foreground">Erased on</dt>
                  <dd>{new Date(claim.claimantExpiresAt).toLocaleDateString()}</dd>
                </>
              )}
            </dl>
          )}
        </Section>

        {claim.counterNotices.length > 0 && (
          <Section title="Counter-notices from owners">
            <div className="space-y-4">
              {claim.counterNotices.map((notice) => (
                <CounterNoticeCard key={notice.id} notice={notice} />
              ))}
            </div>
          </Section>
        )}

        <Section title="What the claim names">
          <TargetsTable
            claim={claim}
            selectable={offerBlock}
            selected={selected}
            onToggle={(targetId) =>
              setSelected((current) =>
                current.includes(targetId)
                  ? current.filter((id) => id !== targetId)
                  : [...current, targetId],
              )
            }
          />
          {canAttach(claim.state) && <AttachFilesForm claimId={claim.id} />}
        </Section>

        <Section title="Audit trail">
          <ol className="space-y-3">
            {claim.events.map((event) => (
              <li key={event.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-xs">
                    {CLAIM_EVENT_LABELS[event.action]}
                  </Badge>
                  {event.toState && event.fromState !== event.toState && (
                    <span className="text-xs text-muted-foreground">
                      {event.fromState ? `${CLAIM_STATE_LABELS[event.fromState]} → ` : ''}
                      {CLAIM_STATE_LABELS[event.toState]}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {new Date(event.createdAt).toLocaleString()} ·{' '}
                    {event.actorUserId ? `by ${event.actorUserId}` : 'anonymous or by Oxy'}
                  </span>
                </div>
                {event.note && (
                  <p className="mt-1 whitespace-pre-wrap text-foreground">{event.note}</p>
                )}
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </ScrollArea>
  );
}

/**
 * One owner's counter-notice (17 U.S.C. § 512(g)(3)), as they sent it. For a
 * copyright claim the claimant was sent this notice, contact details
 * included; for any other kind, only that it is disputed.
 */
function CounterNoticeCard({ notice }: { notice: ContentClaimCounterNoticeView }) {
  const statement = notice.statement;
  return (
    <div className="rounded-md border border-border p-4 space-y-3">
      <p className="text-xs text-muted-foreground">
        Sent {new Date(notice.createdAt).toLocaleString()}
        {notice.submittedByUserId ? ` by ${notice.submittedByUserId}` : ''} · covers{' '}
        {notice.fileIds.length} {notice.fileIds.length === 1 ? 'file' : 'files'} · statements
        affirmed as worded on {notice.statementVersion}
      </p>
      {statement === null ? (
        <p className="text-sm text-muted-foreground">
          The owner's identity and statement were erased at the end of their retention period.
        </p>
      ) : (
        <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd>{statement.name}</dd>
          <dt className="text-muted-foreground">Address</dt>
          <dd className="whitespace-pre-wrap">{statement.address}</dd>
          <dt className="text-muted-foreground">Telephone</dt>
          <dd>{statement.phone}</dd>
          <dt className="text-muted-foreground">Email</dt>
          <dd>{statement.email}</dd>
          <dt className="text-muted-foreground">Material removed</dt>
          <dd className="whitespace-pre-wrap">{statement.materialDescription}</dd>
          <dt className="text-muted-foreground">Where it appeared</dt>
          <dd className="break-all">{statement.materialLocation}</dd>
          <dt className="text-muted-foreground">Why it is a mistake</dt>
          <dd className="whitespace-pre-wrap">{statement.explanation}</dd>
          <dt className="text-muted-foreground">Signature</dt>
          <dd>{statement.signature}</dd>
        </dl>
      )}
      <p className="text-xs text-muted-foreground break-all">Files: {notice.fileIds.join(', ')}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function TargetsTable({
  claim,
  selectable,
  selected,
  onToggle,
}: {
  claim: ContentClaimDetailView;
  selectable: boolean;
  selected: string[];
  onToggle: (targetId: string) => void;
}) {
  const preview = useClaimTargetPreview(claim.id);
  const [shown, setShown] = useState<{ targetId: string; url: string; mime?: string } | null>(null);

  async function openPreview(target: ContentClaimTargetView) {
    try {
      const { url } = await preview.mutateAsync(target.id);
      setShown({ targetId: target.id, url, mime: target.file?.mime });
    } catch (error) {
      toast.error(getErrorMessage(error, 'The preview could not be opened'));
    }
  }

  if (claim.targets.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing yet.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              {selectable && <th className="px-3 py-2" aria-label="Select" />}
              <th className="px-4 py-2 font-medium text-muted-foreground">Target</th>
              <th className="px-4 py-2 font-medium text-muted-foreground">File</th>
              <th className="px-4 py-2 font-medium text-muted-foreground">Block</th>
              <th className="px-4 py-2 font-medium text-muted-foreground" />
            </tr>
          </thead>
          <tbody>
            {claim.targets.map((target) => (
              <tr key={target.id} className="border-b border-border last:border-0 align-top">
                {selectable && (
                  <td className="px-3 py-2">
                    {isBlockableTarget(target) && (
                      <input
                        type="checkbox"
                        aria-label="Block this target"
                        checked={selected.includes(target.id)}
                        onChange={() => onToggle(target.id)}
                      />
                    )}
                  </td>
                )}
                <td className="px-4 py-2 max-w-sm">
                  <p className="text-xs text-muted-foreground">
                    {target.source === 'claimant' ? 'From the claimant' : 'Attached by staff'} ·{' '}
                    {TARGET_RESOLUTION_LABELS[target.resolution]}
                  </p>
                  {target.url && (
                    <a
                      href={target.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="break-all underline underline-offset-4"
                    >
                      {target.url}
                    </a>
                  )}
                </td>
                <td className="px-4 py-2">
                  {target.fileId ? (
                    <>
                      <p className="font-mono text-xs">{target.fileId}</p>
                      {target.file ? (
                        <p className="text-xs text-muted-foreground">
                          {target.file.status} · {target.file.visibility} · {target.file.mime} ·
                          owned by {target.file.ownerKind}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">The file row is gone</p>
                      )}
                    </>
                  ) : target.sha256 ? (
                    <p className="text-xs text-muted-foreground">
                      The file row is gone; its bytes are named by hash
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">No file yet</p>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                  {target.blockedAt ? `Blocked ${new Date(target.blockedAt).toLocaleString()}` : ''}
                  {target.unblockedAt ? (
                    <>
                      <br />
                      Lifted {new Date(target.unblockedAt).toLocaleString()}
                    </>
                  ) : null}
                </td>
                <td className="px-4 py-2">
                  {target.fileId && (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => void openPreview(target)}
                      disabled={preview.isPending}
                    >
                      Preview
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {shown && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Preview — the link works for five minutes and only for you.
            </p>
            <Button variant="ghost" size="xs" onClick={() => setShown(null)}>
              Close
            </Button>
          </div>
          {previewKind(shown.mime) === 'image' ? (
            <img src={shown.url} alt="Claimed file" className="max-h-96 max-w-full rounded" />
          ) : previewKind(shown.mime) === 'video' ? (
            <video src={shown.url} controls className="max-h-96 max-w-full rounded">
              <track kind="captions" />
            </video>
          ) : (
            <a
              href={shown.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline underline-offset-4"
            >
              Open the file
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function AttachFilesForm({ claimId }: { claimId: string }) {
  const attach = useAttachClaimTargets(claimId);
  const [fileIds, setFileIds] = useState('');
  const [url, setUrl] = useState('');
  const ids = parseFileIds(fileIds);

  async function submit() {
    try {
      const result = await attach.mutateAsync({ fileIds: ids, url: url.trim() || undefined });
      toast.success(
        result.alreadyAttached.length > 0
          ? `Attached ${result.attached.length}; ${result.alreadyAttached.length} already were`
          : `Attached ${result.attached.length}`,
      );
      setFileIds('');
      setUrl('');
    } catch (error) {
      toast.error(getErrorMessage(error, 'The files could not be attached'));
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-border p-4">
      <p className="text-sm font-medium">Attach files</p>
      <p className="text-xs text-muted-foreground">
        For a page the claim links to: open it, find the Oxy files it shows, and attach them by id.
      </p>
      <Label htmlFor="claim-file-ids" className="text-xs">
        File ids (separated by commas, spaces or lines)
      </Label>
      <Textarea
        id="claim-file-ids"
        value={fileIds}
        onChange={(event) => setFileIds(event.target.value)}
        rows={2}
        spellCheck={false}
      />
      <Label htmlFor="claim-file-page" className="text-xs">
        The page they were found on (optional)
      </Label>
      <Input
        id="claim-file-page"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://"
        spellCheck={false}
      />
      <Button
        size="sm"
        onClick={() => void submit()}
        disabled={ids.length === 0 || attach.isPending}
      >
        {attach.isPending ? 'Attaching…' : 'Attach'}
      </Button>
    </div>
  );
}

type NoteAction = 'block' | 'reject' | 'counter' | 'reinstate' | 'uphold' | 'note';

const NOTE_ACTIONS: Record<
  NoteAction,
  {
    title: string;
    description: string;
    label: string;
    required: boolean;
    confirm: string;
    destructive: boolean;
  }
> = {
  block: {
    title: 'Block these files',
    description:
      'This takes the files’ exact bytes down for EVERY owner who holds them, not only the one named: every copy stops being served, leaves the CDN, and can never be uploaded, imported or copied again by anyone. The owners are emailed and the applications using the files are told. The claimant is told the content was removed.',
    label: 'Note for the audit trail (optional)',
    required: false,
    confirm: 'Block',
    destructive: true,
  },
  reject: {
    title: 'Reject the claim',
    description:
      'Nothing is taken down and the claim closes. The reason below is emailed to the claimant.',
    label: 'Reason (sent to the claimant)',
    required: true,
    confirm: 'Reject',
    destructive: false,
  },
  counter: {
    title: 'Record a counter-notice',
    description:
      'For a counter-notice the owner sent by email rather than from their account (one sent from the account is recorded on its own, below). Summarize their response in your own words: the summary is emailed to the claimant. Do not include the owner’s identity.',
    label: 'Summary (sent to the claimant)',
    required: true,
    confirm: 'Record',
    destructive: false,
  },
  reinstate: {
    title: 'Reinstate the content',
    description:
      'This claim’s blocks are lifted: files whose bytes no other claim blocks are served again, and their owners and the claimant are emailed. The claim closes.',
    label: 'Why (optional, sent to the claimant)',
    required: false,
    confirm: 'Reinstate',
    destructive: false,
  },
  uphold: {
    title: 'Uphold the claim',
    description:
      'The blocks stand for good and the claim closes. The claimant and the owners are emailed.',
    label: 'Note for the audit trail (optional)',
    required: false,
    confirm: 'Uphold',
    destructive: false,
  },
  note: {
    title: 'Add a note',
    description: 'The note is added to the audit trail. Nobody outside Oxy sees it.',
    label: 'Note',
    required: true,
    confirm: 'Add note',
    destructive: false,
  },
};

function ClaimActions({
  claim,
  selected,
  offerBlock,
  onBlocked,
}: {
  claim: ContentClaimDetailView;
  selected: string[];
  offerBlock: boolean;
  onBlocked: () => void;
}) {
  const startReview = useStartClaimReview(claim.id);
  const block = useBlockClaimTargets(claim.id);
  const reject = useRejectClaim(claim.id);
  const counter = useRecordCounterNotice(claim.id);
  const reinstate = useReinstateClaim(claim.id);
  const uphold = useUpholdClaim(claim.id);
  const addNote = useAddClaimNote(claim.id);
  const [open, setOpen] = useState<NoteAction | null>(null);
  const [note, setNote] = useState('');

  const pending =
    startReview.isPending ||
    block.isPending ||
    reject.isPending ||
    counter.isPending ||
    reinstate.isPending ||
    uphold.isPending ||
    addNote.isPending;

  async function run(action: NoteAction) {
    const text = note.trim();
    try {
      switch (action) {
        case 'block': {
          const result = await block.mutateAsync({
            targetIds: selected.length > 0 ? selected : undefined,
            note: text || undefined,
          });
          onBlocked();
          toast.success(
            `Blocked ${result.filesBlocked} file${result.filesBlocked === 1 ? '' : 's'} across ${result.hashesBlocked} content hash${result.hashesBlocked === 1 ? '' : 'es'}`,
          );
          break;
        }
        case 'reject':
          await reject.mutateAsync({ reason: text });
          toast.success('Claim rejected');
          break;
        case 'counter':
          await counter.mutateAsync({ note: text });
          toast.success('Counter-notice recorded');
          break;
        case 'reinstate': {
          const result = await reinstate.mutateAsync({ note: text || undefined });
          toast.success(`Reinstated: ${result.filesRestored} file(s) served again`);
          break;
        }
        case 'uphold':
          await uphold.mutateAsync({ note: text || undefined });
          toast.success('Claim upheld');
          break;
        case 'note':
          await addNote.mutateAsync({ note: text });
          toast.success('Note added');
          break;
      }
      setOpen(null);
      setNote('');
    } catch (error) {
      toast.error(getErrorMessage(error, 'The action could not be completed'));
    }
  }

  const config = open ? NOTE_ACTIONS[open] : null;
  const blockLabel =
    selected.length > 0 ? `Block ${selected.length} selected` : 'Block every file target';

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canStartReview(claim.state) && (
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startReview
              .mutateAsync()
              .then(() => toast.success('Review started'))
              .catch((error: unknown) =>
                toast.error(getErrorMessage(error, 'The review could not be started')),
              )
          }
        >
          Start review
        </Button>
      )}
      {offerBlock && (
        <Button variant="destructive" size="sm" disabled={pending} onClick={() => setOpen('block')}>
          {blockLabel}
        </Button>
      )}
      {canReject(claim.state) && (
        <Button variant="outline" size="sm" disabled={pending} onClick={() => setOpen('reject')}>
          Reject
        </Button>
      )}
      {canRecordCounterNotice(claim.state) && (
        <Button variant="outline" size="sm" disabled={pending} onClick={() => setOpen('counter')}>
          Record counter-notice
        </Button>
      )}
      {canReinstate(claim.state) && (
        <Button variant="outline" size="sm" disabled={pending} onClick={() => setOpen('reinstate')}>
          Reinstate
        </Button>
      )}
      {canUphold(claim.state) && (
        <Button variant="outline" size="sm" disabled={pending} onClick={() => setOpen('uphold')}>
          Uphold
        </Button>
      )}
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => setOpen('note')}>
        Add note
      </Button>

      <AlertDialog
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) {
            setOpen(null);
            setNote('');
          }
        }}
      >
        {config && open && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {open === 'block' ? `${config.title} (${blockLabel.toLowerCase()})` : config.title}
              </AlertDialogTitle>
              <AlertDialogDescription>{config.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-2">
              <Label htmlFor="claim-action-note" className="text-sm">
                {config.label}
              </Label>
              <Textarea
                id="claim-action-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={4}
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  // Keep the dialog open until the request answers.
                  event.preventDefault();
                  void run(open);
                }}
                disabled={pending || (config.required && note.trim().length === 0)}
                className={
                  config.destructive
                    ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                    : undefined
                }
              >
                {pending ? 'Working…' : config.confirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  );
}
