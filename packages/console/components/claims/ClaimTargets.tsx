import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Chip } from '@oxy.so/bloom/chip';
import { DataTable, type DataTableColumn, DataTableRowActions } from '@oxy.so/bloom/data-table';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiEyeLine } from '@oxy.so/bloom/icons/RiEyeLine';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';
import type { ContentClaimDetailView, ContentClaimTargetView } from '@oxy.so/contracts';
import { useMemo, useState } from 'react';
import { Image, View } from 'react-native';

import { useAttachClaimTargets, useClaimTargetPreview } from '@/hooks/use-content-claims';
import { canAttach, isBlockableTarget, parseFileIds, previewKind } from '@/lib/content-claims';
import { useTranslation } from '@/lib/i18n';

interface ClaimTargetsProps {
  claim: ContentClaimDetailView;
  /** Whether rows can be ticked for a block. */
  selectable: boolean;
  selected: Array<string>;
  onSelectionChange: (targetIds: Array<string>) => void;
}

/** Attach Oxy files to a claim by id (what a page URL shows). */
function AttachFiles({ claimId }: { claimId: string }) {
  const { t } = useTranslation();
  const attach = useAttachClaimTargets(claimId);
  const [fileIds, setFileIds] = useState('');
  const [url, setUrl] = useState('');
  const ids = parseFileIds(fileIds);

  const submit = () =>
    attach.mutate(
      { fileIds: ids, url: url.trim() || undefined },
      {
        onSuccess: (result) => {
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
        },
        onError: () => toast.error(t('claimsPage.attach.failed')),
      },
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('claimsPage.attach.title')}</CardTitle>
        <CardDescription>{t('claimsPage.attach.hint')}</CardDescription>
      </CardHeader>
      <CardBody>
        <View className="gap-4">
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
              onPress={submit}
              disabled={ids.length === 0}
              loading={attach.isPending}
            >
              {t('claimsPage.attach.submit')}
            </Button>
          </View>
        </View>
      </CardBody>
    </Card>
  );
}

/**
 * What the claim names: a table of targets (selectable for a block while the state allows
 * one), a time-boxed preview of each file, and the form that attaches more files.
 */
export function ClaimTargets({
  claim,
  selectable,
  selected,
  onSelectionChange,
}: ClaimTargetsProps) {
  const { t } = useTranslation();
  const preview = useClaimTargetPreview(claim.id);
  const [shown, setShown] = useState<{ url: string; mime?: string } | null>(null);

  const { mutate: mintPreview } = preview;
  const columns = useMemo<Array<DataTableColumn<ContentClaimTargetView>>>(() => {
    const openPreview = (target: ContentClaimTargetView) =>
      mintPreview(target.id, {
        onSuccess: ({ url }) => setShown({ url, mime: target.file?.mime }),
        onError: () => toast.error(t('claimsPage.targets.previewFailed')),
      });
    return [
      {
        id: 'target',
        header: t('claimsPage.targets.target'),
        basis: 300,
        cell: ({ row }) => (
          <View className="items-start gap-1">
            <Muted className="text-xs">
              {`${
                row.source === 'claimant'
                  ? t('claimsPage.targets.fromClaimant')
                  : t('claimsPage.targets.attachedByStaff')
              } · ${t(`claimsPage.resolutions.${row.resolution}`)}`}
            </Muted>
            {row.url ? (
              <Button
                appearance="plain"
                tone="accent"
                size="xs"
                href={row.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
              >
                {row.url}
              </Button>
            ) : null}
          </View>
        ),
      },
      {
        id: 'file',
        header: t('claimsPage.targets.file'),
        basis: 280,
        cell: ({ row }) =>
          row.fileId ? (
            <View className="gap-0.5">
              <Muted selectable className="font-mono text-xs">
                {row.fileId}
              </Muted>
              <Muted className="text-xs">
                {row.file
                  ? t('claimsPage.targets.fileMeta', {
                      status: row.file.status,
                      visibility: row.file.visibility,
                      mime: row.file.mime,
                      owner: row.file.ownerKind,
                    })
                  : t('claimsPage.targets.rowGone')}
              </Muted>
            </View>
          ) : (
            <Muted className="text-xs">
              {row.sha256 ? t('claimsPage.targets.namedByHash') : t('claimsPage.targets.noFile')}
            </Muted>
          ),
      },
      {
        id: 'block',
        header: t('claimsPage.targets.block'),
        basis: 180,
        cell: ({ row }) => (
          <View className="items-start gap-1">
            {row.blockedAt ? (
              <Chip size="sm" color="error">
                {t('claimsPage.targets.blockedAt', {
                  date: new Date(row.blockedAt).toLocaleDateString(),
                })}
              </Chip>
            ) : null}
            {row.unblockedAt ? (
              <Chip size="sm">
                {t('claimsPage.targets.liftedAt', {
                  date: new Date(row.unblockedAt).toLocaleDateString(),
                })}
              </Chip>
            ) : null}
          </View>
        ),
      },
      {
        id: 'actions',
        header: '',
        headerAccessibilityLabel: t('claimsPage.targets.preview'),
        width: 56,
        cell: ({ row }) =>
          row.fileId ? (
            <DataTableRowActions
              name={row.fileId}
              actions={[
                {
                  icon: RiEyeLine,
                  label: t('claimsPage.targets.preview'),
                  onPress: () => openPreview(row),
                },
              ]}
            />
          ) : null,
      },
    ];
  }, [t, mintPreview]);

  return (
    <View className="gap-6">
      <DataTable
        layout="inset"
        rows={claim.targets}
        columns={columns}
        getRowId={(row) => row.id}
        accessibilityLabel={t('claimsPage.sections.targets')}
        title={t('claimsPage.sections.targets')}
        selectable={selectable}
        selectedRowIds={selected}
        onSelectionChange={(ids) =>
          onSelectionChange(
            ids.filter((id) => {
              const target = claim.targets.find((candidate) => candidate.id === id);
              return target !== undefined && isBlockableTarget(target);
            }),
          )
        }
        pageSize={50}
        minWidth={780}
        emptyState={<EmptyState variant="compact" title={t('claimsPage.targets.none')} />}
      />

      {canAttach(claim.state) && <AttachFiles claimId={claim.id} />}

      {shown && (
        <Dialog
          open
          onClose={() => setShown(null)}
          placement={{ base: 'bottom', md: 'right' }}
          title={t('claimsPage.targets.claimedFile')}
          description={t('claimsPage.targets.previewNote')}
          actions={[{ label: t('common.close'), color: 'cancel' }]}
        >
          {previewKind(shown.mime) === 'image' ? (
            <Image
              source={{ uri: shown.url }}
              accessibilityLabel={t('claimsPage.targets.claimedFile')}
              resizeMode="contain"
              className="h-96 w-full"
            />
          ) : (
            <Button
              appearance="outline"
              href={shown.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
            >
              {t('claimsPage.targets.openFile')}
            </Button>
          )}
        </Dialog>
      )}
    </View>
  );
}
