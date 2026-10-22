import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import type { ContentClaimDetailView } from '@oxy.so/contracts';
import { useState } from 'react';
import { View } from 'react-native';

import {
  useAddClaimNote,
  useBlockClaimTargets,
  useRecordCounterNotice,
  useReinstateClaim,
  useRejectClaim,
  useStartClaimReview,
  useUpholdClaim,
} from '@/hooks/use-content-claims';
import { classifyApiError } from '@/lib/api-error';
import {
  canBlock,
  canRecordCounterNotice,
  canReinstate,
  canReject,
  canStartReview,
  canUphold,
} from '@/lib/content-claims';
import { useTranslation } from '@/lib/i18n';

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

interface ClaimActionsProps {
  claim: ContentClaimDetailView;
  /** Target ids ticked for a block; empty blocks every blockable target. */
  selected: Array<string>;
  /** The state allows a block and at least one target can be blocked. */
  offerBlock: boolean;
  onBlocked: () => void;
}

/**
 * The actions a claim's state allows, mirroring the API's state machine (the API is the
 * authority: a transition another reviewer already made answers 409). Everything that
 * changes what is served, or writes to the claimant, confirms in a dialog.
 */
export function ClaimActions({ claim, selected, offerBlock, onBlocked }: ClaimActionsProps) {
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

  const close = () => {
    setOpen(null);
    setNote('');
  };
  const done = (message: string) => {
    toast.success(message);
    close();
  };
  const failed = (error: unknown) =>
    toast.error(
      classifyApiError(error) === 'conflict'
        ? t('state.conflict.body')
        : t('claimsPage.toast.actionFailed'),
    );

  const run = (action: NoteAction) => {
    const text = note.trim();
    const options = { onError: failed };
    switch (action) {
      case 'block':
        return block.mutate(
          { targetIds: selected.length > 0 ? selected : undefined, note: text || undefined },
          {
            ...options,
            onSuccess: (result) => {
              onBlocked();
              done(
                t('claimsPage.toast.blocked', {
                  files: result.filesBlocked,
                  hashes: result.hashesBlocked,
                }),
              );
            },
          },
        );
      case 'reject':
        return reject.mutate(
          { reason: text },
          { ...options, onSuccess: () => done(t('claimsPage.toast.rejected')) },
        );
      case 'counter':
        return counter.mutate(
          { note: text },
          { ...options, onSuccess: () => done(t('claimsPage.toast.counterRecorded')) },
        );
      case 'reinstate':
        return reinstate.mutate(
          { note: text || undefined },
          {
            ...options,
            onSuccess: (result) =>
              done(t('claimsPage.toast.reinstated', { files: result.filesRestored })),
          },
        );
      case 'uphold':
        return uphold.mutate(
          { note: text || undefined },
          { ...options, onSuccess: () => done(t('claimsPage.toast.upheld')) },
        );
      case 'note':
        return addNote.mutate(
          { note: text },
          { ...options, onSuccess: () => done(t('claimsPage.toast.noteAdded')) },
        );
    }
  };

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
            startReview.mutate(undefined, {
              onSuccess: () => toast.success(t('claimsPage.toast.reviewStarted')),
              onError: () => toast.error(t('claimsPage.toast.reviewFailed')),
            })
          }
        >
          {t('claimsPage.actions.startReview')}
        </Button>
      )}
      {offerBlock && canBlock(claim.state) && (
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
              label: t(`claimsPage.actions.${open}.confirm`),
              color: config.destructive ? 'destructive' : 'default',
              disabled: pending || (config.required && note.trim().length === 0),
              loading: pending,
              // Stays open until the request answers.
              shouldCloseOnPress: false,
              onPress: () => run(open),
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
