import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import type { Application, CallerAccess } from '@/hooks/use-applications';
import { useDeleteApplication, useUpdateApplication } from '@/hooks/use-applications';
import { getErrorMessage } from '@/lib/api-error';
import { isDeleteConfirmed } from '@/lib/application-delete';
import { availablePaymentsScopes, hasAliaMachineScopes } from '@/lib/application-scopes';
import { useTranslation } from '@/lib/i18n';
import { stripSensitiveImageUrlQueryParams } from '@/lib/image-upload';
import { TextAreaField, TextInputField, SwitchRow } from './form-fields';
import { arraysEqual, nextApplicationScopes } from './general-draft';
import { LogoUploadField } from './logo-upload-field';
import { CopyValue, SectionBlock } from './primitives';

interface GeneralSectionProps {
  application: Application;
  access: CallerAccess;
}

export function GeneralSection({ application, access }: GeneralSectionProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { oxyServices } = useAuth();
  const canEdit = access.can('app:update');
  const canDelete = access.can('app:delete');
  const updateApplication = useUpdateApplication();
  const deleteApplication = useDeleteApplication();

  const [name, setName] = useState(application.name);
  const [description, setDescription] = useState(application.description ?? '');
  const [websiteUrl, setWebsiteUrl] = useState(application.websiteUrl ?? '');
  const [privacyPolicyUrl, setPrivacyPolicyUrl] = useState(application.privacyPolicyUrl ?? '');
  const [termsUrl, setTermsUrl] = useState(application.termsUrl ?? '');
  const [icon, setIcon] = useState(application.icon ?? '');
  const [redirectUris, setRedirectUris] = useState<Array<string>>(application.redirectUris);
  const [newRedirectUri, setNewRedirectUri] = useState('');
  // Through `availablePaymentsScopes`, which returns `PaymentsScope[]`, so a
  // misspelt scope here is a build error (`application.scopes` is `string[]`).
  const grantedPaymentsScopes = availablePaymentsScopes(application.scopes);
  const [paymentsRead, setPaymentsRead] = useState(grantedPaymentsScopes.includes('payments:read'));
  const [paymentsWrite, setPaymentsWrite] = useState(
    grantedPaymentsScopes.includes('payments:write'),
  );
  // Null until touched, so saving other fields preserves a partial grant.
  const [aliaMachineAccess, setAliaMachineAccess] = useState<boolean | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  // Deleting an application deletes every file it owns at once (ADR 0043 D8),
  // so the person types its name; the API compares it the same way.
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const deleteConfirmed = isDeleteConfirmed(deleteConfirmName, application.name);

  const nextScopes = nextApplicationScopes(application.scopes, {
    paymentsRead,
    paymentsWrite,
    aliaMachineAccess,
  });

  const isDirty =
    name !== application.name ||
    description !== (application.description ?? '') ||
    websiteUrl !== (application.websiteUrl ?? '') ||
    privacyPolicyUrl !== (application.privacyPolicyUrl ?? '') ||
    termsUrl !== (application.termsUrl ?? '') ||
    icon !== (application.icon ?? '') ||
    !arraysEqual(redirectUris, application.redirectUris) ||
    !arraysEqual(nextScopes, application.scopes);

  const handleAddRedirectUri = () => {
    const value = newRedirectUri.trim();
    if (!value) return;
    if (redirectUris.includes(value)) {
      toast.error(t('applications.general.redirectDuplicate'));
      return;
    }
    setRedirectUris([...redirectUris, value]);
    setNewRedirectUri('');
  };

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error(t('applications.general.nameRequired'));
      return;
    }
    try {
      await updateApplication.mutateAsync({
        appId: application._id,
        data: {
          name: name.trim(),
          description: description.trim() || undefined,
          websiteUrl: websiteUrl.trim() || undefined,
          // Empty string clears the stored legal URL server-side.
          privacyPolicyUrl: privacyPolicyUrl.trim(),
          termsUrl: termsUrl.trim(),
          // Empty string clears the logo. Strip credentials defensively before
          // saving because application metadata can be exposed publicly.
          icon: stripSensitiveImageUrlQueryParams(icon),
          redirectUris,
          scopes: nextScopes,
        },
      });
      toast.success(t('applications.general.saved'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.general.saveFailed')));
    }
  };

  const closeDeleteDialog = () => {
    setShowDeleteDialog(false);
    setDeleteConfirmName('');
  };

  const handleDelete = async () => {
    if (!deleteConfirmed) return;
    try {
      await deleteApplication.mutateAsync({
        appId: application._id,
        confirmName: deleteConfirmName,
      });
      closeDeleteDialog();
      toast.success(t('applications.general.deleted'));
      router.replace('/apps');
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.general.deleteFailed')));
    }
  };

  const statusLabel =
    application.status === 'active' ? t('applications.status.active') : application.status;

  return (
    <View className="gap-8">
      <SectionBlock
        title={t('applications.general.title')}
        description={t('applications.general.subtitle')}
      >
        <TextInputField
          label={t('applications.fields.name')}
          value={name}
          onChangeText={setName}
          placeholder={t('applications.fields.namePlaceholder')}
          maxLength={100}
          disabled={!canEdit}
          autoCapitalize="sentences"
        />
        <TextAreaField
          label={t('applications.fields.description')}
          value={description}
          onChangeText={setDescription}
          placeholder={t('applications.fields.descriptionPlaceholder')}
          maxLength={500}
          disabled={!canEdit}
        />
        <TextInputField
          label={t('applications.fields.websiteUrl')}
          value={websiteUrl}
          onChangeText={setWebsiteUrl}
          placeholder="https://example.com"
          keyboardType="url"
          disabled={!canEdit}
        />
        <TextInputField
          label={t('applications.general.privacyPolicyUrl')}
          value={privacyPolicyUrl}
          onChangeText={setPrivacyPolicyUrl}
          placeholder="https://example.com/privacy"
          keyboardType="url"
          disabled={!canEdit}
        />
        <TextInputField
          label={t('applications.general.termsUrl')}
          value={termsUrl}
          onChangeText={setTermsUrl}
          placeholder="https://example.com/terms"
          keyboardType="url"
          disabled={!canEdit}
        />
        <View className="gap-2">
          <Text className="text-sm font-medium text-foreground">
            {t('applications.general.logo')}
          </Text>
          <LogoUploadField
            oxyServices={oxyServices}
            value={icon}
            name={application.name}
            onChange={setIcon}
            onError={(message) => toast.error(message)}
            disabled={!canEdit}
          />
        </View>
      </SectionBlock>

      <SectionBlock
        title={t('applications.general.redirectTitle')}
        description={t('applications.general.redirectBody')}
      >
        {redirectUris.length === 0 ? (
          <Text className="text-sm text-muted-foreground">
            {t('applications.general.redirectEmpty')}
          </Text>
        ) : (
          <View className="gap-2">
            {redirectUris.map((uri) => (
              <View
                key={uri}
                className="flex-row items-center justify-between gap-2 rounded-lg border border-border py-1 pl-3 pr-1"
              >
                <Text
                  selectable
                  numberOfLines={1}
                  className="min-w-0 flex-1 font-mono text-sm text-foreground"
                >
                  {uri}
                </Text>
                {canEdit ? (
                  <Button
                    iconOnly
                    size="sm"
                    appearance="plain"
                    tone="danger"
                    leadingIcon={RiDeleteBinLine}
                    accessibilityLabel={t('applications.general.redirectRemove')}
                    onPress={() => setRedirectUris(redirectUris.filter((item) => item !== uri))}
                  />
                ) : null}
              </View>
            ))}
          </View>
        )}
        {canEdit ? (
          <View className="flex-row items-end gap-2">
            <View className="min-w-0 flex-1">
              <TextInputField
                label={t('applications.general.redirectNew')}
                value={newRedirectUri}
                onChangeText={setNewRedirectUri}
                placeholder="https://example.com/callback"
                keyboardType="url"
                onSubmitEditing={handleAddRedirectUri}
              />
            </View>
            <Button
              appearance="outline"
              leadingIcon={RiAddLine}
              disabled={!newRedirectUri.trim()}
              onPress={handleAddRedirectUri}
            >
              {t('applications.general.redirectAdd')}
            </Button>
          </View>
        ) : null}
      </SectionBlock>

      <SectionBlock
        title={t('applications.general.paymentsTitle')}
        description={t('applications.general.paymentsBody')}
      >
        <View className="gap-3 rounded-lg border border-border p-3">
          <SwitchRow
            title="payments:read"
            description={t('applications.scopes.paymentsRead')}
            checked={paymentsRead}
            onCheckedChange={setPaymentsRead}
            disabled={!canEdit}
          />
          <SwitchRow
            title="payments:write"
            description={t('applications.scopes.paymentsWrite')}
            checked={paymentsWrite}
            onCheckedChange={setPaymentsWrite}
            disabled={!canEdit}
          />
        </View>
      </SectionBlock>

      <SectionBlock
        title={t('applications.general.aliaTitle')}
        description={t('applications.general.aliaBody')}
      >
        <View className="rounded-lg border border-border p-3">
          <SwitchRow
            title="alia:chat + inference:invoke"
            description={t('applications.general.aliaToggleHint')}
            accessibilityLabel={t('applications.general.aliaToggle')}
            checked={aliaMachineAccess ?? hasAliaMachineScopes(application.scopes)}
            onCheckedChange={setAliaMachineAccess}
            disabled={!canEdit}
          />
        </View>
      </SectionBlock>

      <SectionBlock
        title={t('applications.general.idTitle')}
        description={t('applications.general.idBody')}
      >
        <View className="flex-row items-center gap-3">
          <View className="min-w-0 flex-1">
            <CopyValue
              value={application._id}
              label={t('applications.general.idCopy')}
              copiedMessage={t('applications.general.idCopied')}
              large
            />
          </View>
          <Badge
            content={statusLabel}
            size="label-small"
            variant={application.status === 'active' ? 'solid' : 'subtle'}
            color={application.status === 'active' ? 'success' : 'default'}
          />
        </View>
      </SectionBlock>

      {canEdit ? (
        <View className="flex-row gap-3 border-t border-border pt-6">
          <Button
            loading={updateApplication.isPending}
            disabled={!isDirty || !name.trim()}
            onPress={() => void handleSave()}
          >
            {t('applications.general.save')}
          </Button>
        </View>
      ) : null}

      {canDelete ? (
        <SectionBlock
          danger
          bordered
          title={t('applications.general.dangerTitle')}
          description={t('applications.general.dangerBody')}
        >
          <View className="flex-row">
            <Button
              appearance="outline"
              tone="danger"
              leadingIcon={RiDeleteBinLine}
              onPress={() => setShowDeleteDialog(true)}
            >
              {t('applications.general.deleteCta')}
            </Button>
          </View>
        </SectionBlock>
      ) : null}

      <Dialog
        open={showDeleteDialog}
        onClose={closeDeleteDialog}
        placement={{ base: 'bottom', md: 'center' }}
        title={t('applications.general.deleteTitle')}
        description={t('applications.general.deleteBody', { name: application.name })}
        actions={[
          { label: t('common.cancel'), color: 'cancel', disabled: deleteApplication.isPending },
          {
            label: t('common.delete'),
            color: 'destructive',
            onPress: () => void handleDelete(),
            disabled: !deleteConfirmed,
            loading: deleteApplication.isPending,
            shouldCloseOnPress: false,
          },
        ]}
        testID="delete-application-dialog"
      >
        <TextInputField
          label={t('applications.general.deleteConfirmLabel', { name: application.name })}
          value={deleteConfirmName}
          onChangeText={setDeleteConfirmName}
          spellCheck={false}
          autoComplete="off"
        />
      </Dialog>
    </View>
  );
}
