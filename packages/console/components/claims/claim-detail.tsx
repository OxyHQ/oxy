import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { Dialog } from '@oxy.so/bloom/dialog';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import type {
  ContentClaimCounterNoticeView,
  ContentClaimDetailView,
  ContentClaimTargetView,
} from '@oxy.so/contracts';
import { Link, type Href } from 'expo-router';
import { type ReactNode, useMemo, useState } from 'react';
import { Image, Text, View } from 'react-native';

import {
  useAddClaimNote,
  useAttachClaimTargets,
  useBlockClaimTargets,
  useClaimTargetPreview,
  useRecordCounterNotice,
  useReinstateClaim,
  useRejectClaim,
  useStartClaimReview,
  useUpholdClaim,
} from '@/hooks/use-content-claims';
import { getErrorMessage } from '@/lib/api-error';
import {
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
import { useTranslation } from '@/lib/i18n';

/** One labelled row of a definition list. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="flex-row flex-wrap gap-x-4 gap-y-0.5">
      <Text className="w-40 text-sm text-muted-foreground">{label}</Text>
      <View className="min-w-48 flex-1">
        {typeof children === 'string' ? (
          <Text selectable className="text-sm text-foreground">
            {children}
          </Text>
        ) : (
          children
        )}
      </View>
    </View>
  );
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href as Href} target="_blank" rel="noopener noreferrer nofollow" asChild>
      <Text accessibilityRole="link" className="text-sm text-foreground underline">
        {children}
      </Text>
    </Link>
  );
}

/**
 * One owner's counter-notice (17 U.S.C. § 512(g)(3)), as they sent it. For a
 * copyright claim the claimant was sent this notice, contact details included; for
 * any other kind, only that it is disputed.
 */
function CounterNoticeCard({ notice }: { notice: ContentClaimCounterNoticeView }) {
  const { t } = useTranslation();
  const statement = notice.statement;
  return (
    <View className="gap-3 rounded-md border border-border p-4">
      <Text className="text-xs text-muted-foreground">
        {t('claimsPage.counterNotice.sent', {
          date: new Date(notice.createdAt).toLocaleString(),
          by: notice.submittedByUserId
            ? t('claimsPage.counterNotice.by', { user: notice.submittedByUserId })
            : '',
          count: notice.fileIds.length,
          version: notice.statementVersion,
        })}
      </Text>
      {statement === null ? (
        <Text className="text-sm text-muted-foreground">
          {t('claimsPage.counterNotice.erased')}
        </Text>
      ) : (
        <View className="gap-2">
          <DetailRow label={t('claimsPage.counterNotice.name')}>{statement.name}</DetailRow>
          <DetailRow label={t('claimsPage.counterNotice.address')}>{statement.address}</DetailRow>
          <DetailRow label={t('claimsPage.counterNotice.phone')}>{statement.phone}</DetailRow>
          <DetailRow label={t('claimsPage.counterNotice.email')}>{statement.email}</DetailRow>
          <DetailRow label={t('claimsPage.counterNotice.material')}>
            {statement.materialDescription}
          </DetailRow>
          <DetailRow label={t('claimsPage.counterNotice.location')}>
            {statement.materialLocation}
          </DetailRow>
          <DetailRow label={t('claimsPage.counterNotice.explanation')}>
            {statement.explanation}
          </DetailRow>
          <DetailRow label={t('claimsPage.counterNotice.signature')}>
            {statement.signature}
          </DetailRow>
        </View>
      )}
      <Text selectable className="text-xs text-muted-foreground">
        {t('claimsPage.counterNotice.files', { ids: notice.fileIds.join(', ') })}
      </Text>
    </View>
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
  selected: Array<string>;
  onToggle: (targetId: string) => void;
}) {
  const { t } = useTranslation();
  const preview = useClaimTargetPreview(claim.id);
  const [shown, setShown] = useState<{ url: string; mime?: string } | null>(null);

  async function openPreview(target: ContentClaimTargetView) {
    try {
      const { url } = await preview.mutateAsync(target.id);
      setShown({ url, mime: target.file?.mime });
    } catch (error) {
      toast.error(getErrorMessage(error, t('claimsPage.targets.previewFailed')));
    }
  }

  const columns = useMemo<Array<DataTableColumn<ContentClaimTargetView>>>(
    () => [
      ...(selectable
        ? [
            {
              id: 'select',
              header: '',
              headerAccessibilityLabel: t('claimsPage.targets.select'),
              width: 48,
              cell: ({ row }: { row: ContentClaimTargetView }) =>
                isBlockableTarget(row) ? (
                  <Checkbox
                    accessibilityLabel={t('claimsPage.targets.blockThis')}
                    checked={selected.includes(row.id)}
                    onCheckedChange={() => onToggle(row.id)}
                  />
                ) : null,
            } satisfies DataTableColumn<ContentClaimTargetView>,
          ]
        : []),
      {
        id: 'target',
        header: t('claimsPage.targets.target'),
        basis: 280,
        cell: ({ row }) => (
          <View className="gap-0.5">
            <Text className="text-xs text-muted-foreground">
              {`${
                row.source === 'claimant'
                  ? t('claimsPage.targets.fromClaimant')
                  : t('claimsPage.targets.attachedByStaff')
              } · ${t(`claimsPage.resolutions.${row.resolution}`)}`}
            </Text>
            {row.url ? <ExternalLink href={row.url}>{row.url}</ExternalLink> : null}
          </View>
        ),
      },
      {
        id: 'file',
        header: t('claimsPage.targets.file'),
        basis: 260,
        cell: ({ row }) =>
          row.fileId ? (
            <View className="gap-0.5">
              <Text selectable className="font-mono text-xs text-foreground">
                {row.fileId}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {row.file
                  ? t('claimsPage.targets.fileMeta', {
                      status: row.file.status,
                      visibility: row.file.visibility,
                      mime: row.file.mime,
                      owner: row.file.ownerKind,
                    })
                  : t('claimsPage.targets.rowGone')}
              </Text>
            </View>
          ) : (
            <Text className="text-xs text-muted-foreground">
              {row.sha256 ? t('claimsPage.targets.namedByHash') : t('claimsPage.targets.noFile')}
            </Text>
          ),
      },
      {
        id: 'block',
        header: t('claimsPage.targets.block'),
        basis: 170,
        cell: ({ row }) => (
          <View className="gap-0.5">
            {row.blockedAt ? (
              <Text className="text-xs text-muted-foreground">
                {t('claimsPage.targets.blockedAt', {
                  date: new Date(row.blockedAt).toLocaleString(),
                })}
              </Text>
            ) : null}
            {row.unblockedAt ? (
              <Text className="text-xs text-muted-foreground">
                {t('claimsPage.targets.liftedAt', {
                  date: new Date(row.unblockedAt).toLocaleString(),
                })}
              </Text>
            ) : null}
          </View>
        ),
      },
      {
        id: 'actions',
        header: '',
        width: 100,
        cell: ({ row }) =>
          row.fileId ? (
            <Button
              appearance="outline"
              size="xs"
              disabled={preview.isPending}
              onPress={() => void openPreview(row)}
            >
              {t('claimsPage.targets.preview')}
            </Button>
          ) : null,
      },
    ],
    // `openPreview` closes over `preview` and `t`, both already listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectable, selected, t, preview.isPending],
  );

  if (claim.targets.length === 0) {
    return <Text className="text-sm text-muted-foreground">{t('claimsPage.targets.none')}</Text>;
  }

  return (
    <View className="gap-3">
      <DataTable
        rows={claim.targets}
        columns={columns}
        getRowId={(row) => row.id}
        accessibilityLabel={t('claimsPage.sections.targets')}
        pageSize={50}
        minWidth={760}
      />

      {shown && (
        <View className="gap-2 rounded-lg border border-border p-3">
          <View className="flex-row items-center justify-between gap-2">
            <Text className="flex-1 text-xs text-muted-foreground">
              {t('claimsPage.targets.previewNote')}
            </Text>
            <Button appearance="plain" size="xs" onPress={() => setShown(null)}>
              {t('common.close')}
            </Button>
          </View>
          {previewKind(shown.mime) === 'image' ? (
            <Image
              source={{ uri: shown.url }}
              accessibilityLabel={t('claimsPage.targets.claimedFile')}
              resizeMode="contain"
              style={{ height: 384, width: '100%' }}
            />
          ) : (
            <ExternalLink href={shown.url}>{t('claimsPage.targets.openFile')}</ExternalLink>
          )}
        </View>
      )}
    </View>
  );
}

function AttachFilesForm({ claimId }: { claimId: string }) {
  const { t } = useTranslation();
  const attach = useAttachClaimTargets(claimId);
  const [fileIds, setFileIds] = useState('');
  const [url, setUrl] = useState('');
  const ids = parseFileIds(fileIds);

  async function submit() {
    try {
      const result = await attach.mutateAsync({ fileIds: ids, url: url.trim() || undefined });
      toast.success(
        result.alreadyAttached.length > 0
          ? t('claimsPage.attach.attachedSome', {
              attached: result.attached.length,
              already: result.alreadyAttached.length,
            })
          : t('claimsPage.attach.attached', { attached: result.attached.length }),
      );
      setFileIds('');
      setUrl('');
    } catch (error) {
      toast.error(getErrorMessage(error, t('claimsPage.attach.failed')));
    }
  }

  return (
    <View className="gap-3 rounded-lg border border-border p-4">
      <View className="gap-1">
        <Text className="text-sm font-medium text-foreground">{t('claimsPage.attach.title')}</Text>
        <Text className="text-xs text-muted-foreground">{t('claimsPage.attach.hint')}</Text>
      </View>
      <Textarea
        label={t('claimsPage.attach.fileIds')}
        value={fileIds}
        onChangeText={setFileIds}
        rows={2}
        spellCheck={false}
        autoCapitalize="none"
      />
      <TextFieldInput
        label={t('claimsPage.attach.page')}
        value={url}
        onChangeText={setUrl}
        placeholder="https://"
        spellCheck={false}
        autoCapitalize="none"
      />
      <View className="items-start">
        <Button
          size="sm"
          onPress={() => void submit()}
          disabled={ids.length === 0 || attach.isPending}
          loading={attach.isPending}
        >
          {attach.isPending ? t('claimsPage.attach.attaching') : t('claimsPage.attach.submit')}
        </Button>
      </View>
    </View>
  );
}

type NoteAction = 'block' | 'reject' | 'counter' | 'reinstate' | 'uphold' | 'note';

/** Which actions need a written note, and which are destructive. The words live in the dictionary. */
const NOTE_ACTIONS: Record<NoteAction, { required: boolean; destructive: boolean }> = {
  block: { required: false, destructive: true },
  reject: { required: true, destructive: false },
  counter: { required: true, destructive: false },
  reinstate: { required: false, destructive: false },
  uphold: { required: false, destructive: false },
  note: { required: true, destructive: false },
};

function ClaimActions({
  claim,
  selected,
  offerBlock,
  onBlocked,
}: {
  claim: ContentClaimDetailView;
  selected: Array<string>;
  offerBlock: boolean;
  onBlocked: () => void;
}) {
  const { t } = useTranslation();
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

  function close() {
    setOpen(null);
    setNote('');
  }

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
            t('claimsPage.toast.blocked', {
              files: result.filesBlocked,
              hashes: result.hashesBlocked,
            }),
          );
          break;
        }
        case 'reject':
          await reject.mutateAsync({ reason: text });
          toast.success(t('claimsPage.toast.rejected'));
          break;
        case 'counter':
          await counter.mutateAsync({ note: text });
          toast.success(t('claimsPage.toast.counterRecorded'));
          break;
        case 'reinstate': {
          const result = await reinstate.mutateAsync({ note: text || undefined });
          toast.success(t('claimsPage.toast.reinstated', { files: result.filesRestored }));
          break;
        }
        case 'uphold':
          await uphold.mutateAsync({ note: text || undefined });
          toast.success(t('claimsPage.toast.upheld'));
          break;
        case 'note':
          await addNote.mutateAsync({ note: text });
          toast.success(t('claimsPage.toast.noteAdded'));
          break;
      }
      close();
    } catch (error) {
      toast.error(getErrorMessage(error, t('claimsPage.toast.actionFailed')));
    }
  }

  const blockLabel =
    selected.length > 0
      ? t('claimsPage.actions.blockSelected', { count: selected.length })
      : t('claimsPage.actions.blockAll');
  const config = open ? NOTE_ACTIONS[open] : null;

  return (
    <View className="flex-row flex-wrap items-center gap-2">
      {canStartReview(claim.state) && (
        <Button
          size="sm"
          disabled={pending}
          onPress={() =>
            startReview
              .mutateAsync()
              .then(() => toast.success(t('claimsPage.toast.reviewStarted')))
              .catch((error: unknown) =>
                toast.error(getErrorMessage(error, t('claimsPage.toast.reviewFailed'))),
              )
          }
        >
          {t('claimsPage.actions.startReview')}
        </Button>
      )}
      {offerBlock && (
        <Button tone="danger" size="sm" disabled={pending} onPress={() => setOpen('block')}>
          {blockLabel}
        </Button>
      )}
      {canReject(claim.state) && (
        <Button appearance="outline" size="sm" disabled={pending} onPress={() => setOpen('reject')}>
          {t('claimsPage.actions.reject.button')}
        </Button>
      )}
      {canRecordCounterNotice(claim.state) && (
        <Button
          appearance="outline"
          size="sm"
          disabled={pending}
          onPress={() => setOpen('counter')}
        >
          {t('claimsPage.actions.counter.button')}
        </Button>
      )}
      {canReinstate(claim.state) && (
        <Button
          appearance="outline"
          size="sm"
          disabled={pending}
          onPress={() => setOpen('reinstate')}
        >
          {t('claimsPage.actions.reinstate.button')}
        </Button>
      )}
      {canUphold(claim.state) && (
        <Button appearance="outline" size="sm" disabled={pending} onPress={() => setOpen('uphold')}>
          {t('claimsPage.actions.uphold.button')}
        </Button>
      )}
      <Button appearance="plain" size="sm" disabled={pending} onPress={() => setOpen('note')}>
        {t('claimsPage.actions.note.button')}
      </Button>

      {open !== null && config !== null && (
        <Dialog
          open
          onClose={close}
          placement={{ base: 'bottom', md: 'center' }}
          title={
            open === 'block'
              ? t('claimsPage.actions.block.titleWithCount', { label: blockLabel.toLowerCase() })
              : t(`claimsPage.actions.${open}.title`)
          }
          description={t(`claimsPage.actions.${open}.description`)}
          actions={[
            { label: t('common.cancel'), color: 'cancel', disabled: pending },
            {
              label: pending
                ? t('claimsPage.actions.working')
                : t(`claimsPage.actions.${open}.confirm`),
              color: config.destructive ? 'destructive' : 'default',
              disabled: pending || (config.required && note.trim().length === 0),
              loading: pending,
              // Keep the dialog open until the request answers.
              shouldCloseOnPress: false,
              onPress: () => void run(open),
            },
          ]}
        >
          <Textarea
            label={t(`claimsPage.actions.${open}.label`)}
            value={note}
            onChangeText={setNote}
            rows={4}
          />
        </Dialog>
      )}
    </View>
  );
}

/**
 * One content claim (ADR 0043 D10): the claimant's statement, what it names, the
 * actions its state allows, and the audit trail.
 *
 * The API decides every transition (a conditional write answering 409 when another
 * reviewer moved the claim first); the buttons offered here only follow the same
 * state machine. Every action's answer is the claim as it now stands.
 */
export function ClaimDetail({ claim }: { claim: ContentClaimDetailView }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Array<string>>([]);
  const blockable = claim.targets.filter(isBlockableTarget);
  const offerBlock = canBlock(claim.state) && blockable.length > 0;
  const claimant = claim.claimant;

  return (
    <View className="gap-8">
      <ClaimActions
        claim={claim}
        selected={selected}
        offerBlock={offerBlock}
        onBlocked={() => setSelected([])}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('claimsPage.sections.claimant')}</CardTitle>
        </CardHeader>
        <CardBody>
          {claimant === null ? (
            <Text className="text-sm text-muted-foreground">
              {claim.claimantExpiresAt
                ? t('claimsPage.claimant.erasedOn', {
                    date: new Date(claim.claimantExpiresAt).toLocaleDateString(),
                  })
                : t('claimsPage.claimant.erased')}
            </Text>
          ) : (
            <View className="gap-2">
              <DetailRow label={t('claimsPage.claimant.name')}>{claimant.name}</DetailRow>
              <DetailRow label={t('claimsPage.claimant.email')}>{claimant.email}</DetailRow>
              {claimant.organization ? (
                <DetailRow label={t('claimsPage.claimant.organization')}>
                  {claimant.organization}
                </DetailRow>
              ) : null}
              <DetailRow label={t('claimsPage.claimant.signature')}>{claimant.signature}</DetailRow>
              {claimant.originalWorkUrl ? (
                <DetailRow label={t('claimsPage.claimant.originalWork')}>
                  <ExternalLink href={claimant.originalWorkUrl}>
                    {claimant.originalWorkUrl}
                  </ExternalLink>
                </DetailRow>
              ) : null}
              <DetailRow label={t('claimsPage.claimant.statement')}>
                {claimant.description}
              </DetailRow>
              {claim.claimantExpiresAt ? (
                <DetailRow label={t('claimsPage.claimant.erasedLabel')}>
                  {new Date(claim.claimantExpiresAt).toLocaleDateString()}
                </DetailRow>
              ) : null}
            </View>
          )}
        </CardBody>
      </Card>

      {claim.counterNotices.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('claimsPage.sections.counterNotices')}</CardTitle>
          </CardHeader>
          <CardBody>
            <View className="gap-4">
              {claim.counterNotices.map((notice) => (
                <CounterNoticeCard key={notice.id} notice={notice} />
              ))}
            </View>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('claimsPage.sections.targets')}</CardTitle>
        </CardHeader>
        <CardBody>
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
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('claimsPage.sections.audit')}</CardTitle>
        </CardHeader>
        <CardBody>
          <View className="gap-3">
            {claim.events.map((event) => (
              <View key={event.id} className="gap-1">
                <View className="flex-row flex-wrap items-center gap-2">
                  <Badge
                    size="label-small"
                    variant="outlined"
                    content={t(`claimsPage.events.${event.action}`)}
                  />
                  {event.toState && event.fromState !== event.toState && (
                    <Text className="text-xs text-muted-foreground">
                      {event.fromState
                        ? t('claimsPage.audit.transition', {
                            from: t(`claimsPage.states.${event.fromState}`),
                            to: t(`claimsPage.states.${event.toState}`),
                          })
                        : t(`claimsPage.states.${event.toState}`)}
                    </Text>
                  )}
                  <Text className="text-xs text-muted-foreground">
                    {t('claimsPage.audit.when', {
                      date: new Date(event.createdAt).toLocaleString(),
                      actor: event.actorUserId
                        ? t('claimsPage.audit.byUser', { user: event.actorUserId })
                        : t('claimsPage.audit.anonymous'),
                    })}
                  </Text>
                </View>
                {event.note ? (
                  <Text selectable className="text-sm text-foreground">
                    {event.note}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        </CardBody>
      </Card>
    </View>
  );
}
