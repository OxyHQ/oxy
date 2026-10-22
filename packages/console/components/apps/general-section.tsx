import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import {
  Card,
  CardBody,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@oxy.so/bloom/card';
import { Code } from '@oxy.so/bloom/code';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { Item } from '@oxy.so/bloom/item';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useAuth } from '@oxy.so/services/ui/client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import type { Application, CallerAccess } from '@/hooks/use-applications';
import { useDeleteApplication, useUpdateApplication } from '@/hooks/use-applications';
import { getErrorMessage } from '@/lib/api-error';
import { copyText } from '@/lib/clipboard';
import { isDeleteConfirmed } from '@/lib/application-delete';
import { availablePaymentsScopes, hasAliaMachineScopes } from '@/lib/application-scopes';
import { useTranslation } from '@/lib/i18n';
import { stripSensitiveImageUrlQueryParams } from '@/lib/image-upload';
import { arraysEqual, nextApplicationScopes } from './general-draft';
import { LogoUploadField } from './logo-upload-field';

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
    <View className="gap-6">
      <Card appearance="outline">
        <CardHeader>
          <CardTitle>{t('applications.general.title')}</CardTitle>
          <CardDescription>{t('applications.general.subtitle')}</CardDescription>
        </CardHeader>
        <CardBody>
          <View className="gap-4">
            <Field label={t('applications.fields.name')}>
              <TextFieldInput
                label={t('applications.fields.name')}
                value={name}
                onChangeText={setName}
                placeholder={t('applications.fields.namePlaceholder')}
                maxLength={100}
                disabled={!canEdit}
                autoCapitalize="sentences"
              />
            </Field>
            <Textarea
              label={t('applications.fields.description')}
              value={description}
              onChangeText={setDescription}
              placeholder={t('applications.fields.descriptionPlaceholder')}
              maxLength={500}
              rows={3}
              disabled={!canEdit}
            />
            <Field label={t('applications.fields.websiteUrl')}>
              <TextFieldInput
                label={t('applications.fields.websiteUrl')}
                value={websiteUrl}
                onChangeText={setWebsiteUrl}
                placeholder="https://example.com"
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                disabled={!canEdit}
              />
            </Field>
            <Field label={t('applications.general.privacyPolicyUrl')}>
              <TextFieldInput
                label={t('applications.general.privacyPolicyUrl')}
                value={privacyPolicyUrl}
                onChangeText={setPrivacyPolicyUrl}
                placeholder="https://example.com/privacy"
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                disabled={!canEdit}
              />
            </Field>
            <Field label={t('applications.general.termsUrl')}>
              <TextFieldInput
                label={t('applications.general.termsUrl')}
                value={termsUrl}
                onChangeText={setTermsUrl}
                placeholder="https://example.com/terms"
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                disabled={!canEdit}
              />
            </Field>
            <Field label={t('applications.general.logo')}>
              <LogoUploadField
                oxyServices={oxyServices}
                value={icon}
                name={application.name}
                onChange={setIcon}
                onError={(message) => toast.error(message)}
                disabled={!canEdit}
              />
            </Field>
          </View>
        </CardBody>
        {canEdit ? (
          <CardFooter>
            <Button
              loading={updateApplication.isPending}
              disabled={!isDirty || !name.trim()}
              onPress={() => void handleSave()}
            >
              {t('applications.general.save')}
            </Button>
          </CardFooter>
        ) : null}
      </Card>

      <Card appearance="outline">
        <CardHeader>
          <CardTitle>{t('applications.general.redirectTitle')}</CardTitle>
          <CardDescription>{t('applications.general.redirectBody')}</CardDescription>
        </CardHeader>
        <CardBody>
          <View className="gap-3">
            {redirectUris.length === 0 ? (
              <Text className="text-sm text-muted-foreground">
                {t('applications.general.redirectEmpty')}
              </Text>
            ) : (
              redirectUris.map((uri) => (
                <Item
                  key={uri}
                  density="compact"
                  title={<Code selectable>{uri}</Code>}
                  trailing={
                    canEdit ? (
                      <Button
                        iconOnly
                        size="sm"
                        appearance="plain"
                        tone="danger"
                        leadingIcon={RiDeleteBinLine}
                        accessibilityLabel={t('applications.general.redirectRemove')}
                        onPress={() => setRedirectUris(redirectUris.filter((item) => item !== uri))}
                      />
                    ) : undefined
                  }
                />
              ))
            )}
            {canEdit ? (
              <View className="flex-row items-end gap-2">
                <View className="min-w-0 flex-1">
                  <Field label={t('applications.general.redirectNew')}>
                    <TextFieldInput
                      label={t('applications.general.redirectNew')}
                      value={newRedirectUri}
                      onChangeText={setNewRedirectUri}
                      placeholder="https://example.com/callback"
                      keyboardType="url"
                      autoCapitalize="none"
                      autoCorrect={false}
                      onSubmitEditing={handleAddRedirectUri}
                    />
                  </Field>
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
          </View>
        </CardBody>
      </Card>

      <GroupedSection
        title={t('applications.general.paymentsTitle')}
        footer={t('applications.general.paymentsBody')}
      >
        <GroupedSectionItem
          title="payments:read"
          description={t('applications.scopes.paymentsRead')}
          rightElement={
            <Switch
              checked={paymentsRead}
              onCheckedChange={setPaymentsRead}
              disabled={!canEdit}
              accessibilityLabel="payments:read"
            />
          }
        />
        <GroupedSectionItem
          title="payments:write"
          description={t('applications.scopes.paymentsWrite')}
          rightElement={
            <Switch
              checked={paymentsWrite}
              onCheckedChange={setPaymentsWrite}
              disabled={!canEdit}
              accessibilityLabel="payments:write"
            />
          }
        />
      </GroupedSection>

      <GroupedSection
        title={t('applications.general.aliaTitle')}
        footer={t('applications.general.aliaBody')}
      >
        <GroupedSectionItem
          title="alia:chat + inference:invoke"
          description={t('applications.general.aliaToggleHint')}
          rightElement={
            <Switch
              checked={aliaMachineAccess ?? hasAliaMachineScopes(application.scopes)}
              onCheckedChange={setAliaMachineAccess}
              disabled={!canEdit}
              accessibilityLabel={t('applications.general.aliaToggle')}
            />
          }
        />
      </GroupedSection>

      <GroupedSection
        title={t('applications.general.idTitle')}
        footer={t('applications.general.idBody')}
      >
        <GroupedSectionItem
          title={application._id}
          accessibilityLabel={t('applications.general.idCopy')}
          icon={<RiFileCopyLine />}
          onPress={() => void copyText(application._id, t('applications.general.idCopied'))}
          rightElement={
            <Badge
              content={statusLabel}
              size="label-small"
              variant={application.status === 'active' ? 'solid' : 'subtle'}
              color={application.status === 'active' ? 'success' : 'default'}
            />
          }
        />
      </GroupedSection>

      {canDelete ? (
        <GroupedSection
          title={t('applications.general.dangerTitle')}
          footer={t('applications.general.dangerBody')}
        >
          <GroupedSectionItem
            destructive
            icon={<RiDeleteBinLine />}
            title={t('applications.general.deleteCta')}
            onPress={() => setShowDeleteDialog(true)}
          />
        </GroupedSection>
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
        <Field label={t('applications.general.deleteConfirmLabel', { name: application.name })}>
          <TextFieldInput
            label={t('applications.general.deleteConfirmLabel', { name: application.name })}
            value={deleteConfirmName}
            onChangeText={setDeleteConfirmName}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
      </Dialog>
    </View>
  );
}
