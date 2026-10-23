import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Field } from '@oxy.so/bloom/field';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { Switch } from '@oxy.so/bloom/switch';
import { TagField } from '@oxy.so/bloom/tag-field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { useState } from 'react';
import { View } from 'react-native';

import {
  type Application,
  type CallerAccess,
  useUpdateApplication,
} from '@/hooks/use-applications';
import { getErrorMessage } from '@/lib/api-error';
import { hasAliaMachineScopes } from '@/lib/application-scopes';
import { copyText } from '@/lib/clipboard';
import { useTranslation } from '@/lib/i18n';
import { stripSensitiveImageUrlQueryParams } from '@/lib/image-upload';
import { ApplicationStatusBadge } from './ApplicationStatusBadge';
import { DeleteApplicationDialog } from './DeleteApplicationDialog';
import {
  draftFromApplication,
  draftScopes,
  type GeneralDraft,
  isDraftDirty,
} from './general-draft';
import { LogoField } from './LogoField';

/**
 * The application's identity, OAuth redirect URIs, scope grants and its danger
 * zone. One draft, one Save: the screen is keyed by application id, so moving
 * between applications mounts a fresh draft.
 */
export function GeneralForm({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const { oxyServices } = useAuth();
  const canEdit = access.can('app:update');
  const canDelete = access.can('app:delete');
  const updateApplication = useUpdateApplication();
  const [draft, setDraft] = useState<GeneralDraft>(() => draftFromApplication(application));
  const [deleting, setDeleting] = useState(false);
  const dirty = isDraftDirty(application, draft);
  const patch = (changes: Partial<GeneralDraft>) =>
    setDraft((current) => ({ ...current, ...changes }));

  const handleSave = async () => {
    if (!draft.name.trim()) {
      toast.error(t('applications.general.nameRequired'));
      return;
    }
    try {
      await updateApplication.mutateAsync({
        appId: application._id,
        data: {
          name: draft.name.trim(),
          description: draft.description.trim() || undefined,
          websiteUrl: draft.websiteUrl.trim() || undefined,
          // An empty string clears the stored legal URL server-side.
          privacyPolicyUrl: draft.privacyPolicyUrl.trim(),
          termsUrl: draft.termsUrl.trim(),
          // Empty clears the logo. Credentials are stripped defensively because
          // application metadata can be exposed publicly.
          icon: stripSensitiveImageUrlQueryParams(draft.icon),
          redirectUris: draft.redirectUris,
          scopes: draftScopes(application, draft),
        },
      });
      toast.success(t('applications.general.saved'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.general.saveFailed')));
    }
  };

  return (
    <>
      <Card appearance="plain" border="thin">
        <CardHeader>
          <CardTitle>{t('applications.general.title')}</CardTitle>
          <CardDescription>{t('applications.general.subtitle')}</CardDescription>
        </CardHeader>
        <CardBody>
          <View className="gap-4">
            <Field label={t('applications.general.logo')}>
              <LogoField
                oxyServices={oxyServices}
                value={draft.icon}
                name={application.name}
                onChange={(icon) => patch({ icon })}
                onError={(message) => toast.error(message)}
                disabled={!canEdit}
              />
            </Field>
            <Field label={t('applications.fields.name')}>
              <TextFieldInput
                label={t('applications.fields.name')}
                value={draft.name}
                onChangeText={(name) => patch({ name })}
                placeholder={t('applications.fields.namePlaceholder')}
                maxLength={100}
                disabled={!canEdit}
              />
            </Field>
            <Textarea
              label={t('applications.fields.description')}
              value={draft.description}
              onChangeText={(description) => patch({ description })}
              placeholder={t('applications.fields.descriptionPlaceholder')}
              maxLength={500}
              rows={3}
              disabled={!canEdit}
            />
            <Field label={t('applications.fields.websiteUrl')}>
              <TextFieldInput
                label={t('applications.fields.websiteUrl')}
                value={draft.websiteUrl}
                onChangeText={(websiteUrl) => patch({ websiteUrl })}
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
                value={draft.privacyPolicyUrl}
                onChangeText={(privacyPolicyUrl) => patch({ privacyPolicyUrl })}
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
                value={draft.termsUrl}
                onChangeText={(termsUrl) => patch({ termsUrl })}
                placeholder="https://example.com/terms"
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                disabled={!canEdit}
              />
            </Field>
          </View>
        </CardBody>
      </Card>

      <Card appearance="plain" border="thin">
        <CardHeader>
          <CardTitle>{t('applications.general.redirectTitle')}</CardTitle>
          <CardDescription>{t('applications.general.redirectBody')}</CardDescription>
        </CardHeader>
        <CardBody>
          <TagField
            label={t('applications.general.redirectTitle')}
            value={draft.redirectUris}
            onChange={(redirectUris) => patch({ redirectUris: [...redirectUris] })}
            placeholder="https://example.com/callback"
            disabled={!canEdit}
            labels={{ remove: (uri) => t('applications.general.redirectRemove', { uri }) }}
          />
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
              checked={draft.paymentsRead}
              onCheckedChange={(paymentsRead) => patch({ paymentsRead })}
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
              checked={draft.paymentsWrite}
              onCheckedChange={(paymentsWrite) => patch({ paymentsWrite })}
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
              checked={draft.aliaMachineAccess ?? hasAliaMachineScopes(application.scopes)}
              onCheckedChange={(aliaMachineAccess) => patch({ aliaMachineAccess })}
              disabled={!canEdit}
              accessibilityLabel={t('applications.general.aliaToggle')}
            />
          }
        />
      </GroupedSection>

      {canEdit ? (
        <View className="flex-row justify-end gap-2">
          <Button
            appearance="outline"
            disabled={!dirty || updateApplication.isPending}
            onPress={() => setDraft(draftFromApplication(application))}
          >
            {t('applications.general.discard')}
          </Button>
          <Button
            loading={updateApplication.isPending}
            disabled={!dirty || !draft.name.trim()}
            onPress={() => void handleSave()}
          >
            {t('applications.general.save')}
          </Button>
        </View>
      ) : null}

      <GroupedSection
        title={t('applications.general.idTitle')}
        footer={t('applications.general.idBody')}
      >
        <GroupedSectionItem
          title={application._id}
          accessibilityLabel={t('applications.general.idCopy')}
          icon={<RiFileCopyLine />}
          onPress={() => void copyText(application._id, t('applications.general.idCopied'))}
          rightElement={<ApplicationStatusBadge status={application.status} />}
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
            onPress={() => setDeleting(true)}
          />
        </GroupedSection>
      ) : null}

      <DeleteApplicationDialog
        application={application}
        open={deleting}
        onClose={() => setDeleting(false)}
      />
    </>
  );
}
