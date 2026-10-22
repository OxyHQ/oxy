import { Admonition } from '@oxy.so/bloom/admonition';
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
import { Field } from '@oxy.so/bloom/field';
import { Item } from '@oxy.so/bloom/item';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { isApplicationPermissionKey } from '@oxy.so/contracts';
import { useState } from 'react';
import { View } from 'react-native';

import type { Application, CallerAccess } from '@/hooks/use-applications';
import {
  type ApplicationPermissionDeclaration,
  useApplicationRoleGrants,
  useApplicationRolePermissions,
  useDeclareApplicationPermissions,
  useGrantApplicationPermission,
  useRevokeApplicationRoleGrant,
} from '@/hooks/use-application-roles';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';

/**
 * Application roles: the permissions THIS application declares about its own
 * users (`payments.operate`, …) and the people who hold them
 * (`docs/auth/application-roles.md`).
 *
 * The application's backend reads these through `@oxy.so/core/server`
 * (`requireAppPermission`), so this is where an app's operators are decided.
 *
 * Minimal on purpose: edit the vocabulary as a list and save it whole (the API
 * is declarative — a key removed here is retired and its grants revoked), grant
 * a key to a person by username, revoke a live grant.
 */
export function RolesSection({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const canManage = access.can('roles:manage');
  const appId = application._id;
  const permissions = useApplicationRolePermissions(appId, true);
  const grants = useApplicationRoleGrants(appId, true);

  if (permissions.isLoading || grants.isLoading) {
    return (
      <View className="gap-3">
        <Skeleton.Box width="100%" height={48} borderRadius={12} />
        <Skeleton.Box width="100%" height={48} borderRadius={12} />
      </View>
    );
  }

  if (permissions.isError || grants.isError) {
    return (
      <Admonition type="error">
        <Text variant="body-2-semibold">{t('applications.roles.loadFailed')}</Text>
        {'\n'}
        {getErrorMessage(permissions.error ?? grants.error, t('applications.roles.tryAgain'))}
      </Admonition>
    );
  }

  const declared = permissions.data?.items ?? [];
  return (
    <View className="gap-6">
      <VocabularyEditor
        key={declared.map((item) => `${item.key}:${item.description}`).join('|')}
        appId={appId}
        declared={declared.map(({ key, description }) => ({ key, description }))}
        canManage={canManage}
      />
      <GrantsPanel
        appId={appId}
        keys={declared.map((item) => item.key)}
        grants={grants.data?.items ?? []}
        canManage={canManage}
      />
    </View>
  );
}

function VocabularyEditor({
  appId,
  declared,
  canManage,
}: {
  appId: string;
  declared: ApplicationPermissionDeclaration[];
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ApplicationPermissionDeclaration[]>(declared);
  const declare = useDeclareApplicationPermissions();

  const invalid = draft.some(
    (row) => !isApplicationPermissionKey(row.key) || row.description.trim().length === 0,
  );
  const duplicate = new Set(draft.map((row) => row.key)).size !== draft.length;
  const dirty = JSON.stringify(draft) !== JSON.stringify(declared);
  const removed = declared.filter((row) => !draft.some((next) => next.key === row.key));

  const save = async () => {
    try {
      const result = await declare.mutateAsync({
        appId,
        permissions: draft.map((row) => ({ key: row.key, description: row.description.trim() })),
      });
      toast.success(
        result.revokedGrants > 0
          ? t('applications.roles.savedRevoked', { count: result.revokedGrants })
          : t('applications.roles.saved'),
      );
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.roles.saveFailed')));
    }
  };

  return (
    <Card appearance="outline">
      <CardHeader>
        <CardTitle>{t('applications.roles.permissionsTitle')}</CardTitle>
        <CardDescription>{t('applications.roles.permissionsBody')}</CardDescription>
      </CardHeader>
      <CardBody>
        <View className="gap-4">
          {draft.length === 0 ? (
            <Text className="text-sm text-muted-foreground">{t('applications.roles.none')}</Text>
          ) : null}

          {draft.map((row, index) => (
            // The rows have no stable identity until saved (the key is being typed).
            <View key={`row-${index}`} className="flex-row items-end gap-2">
              <View className="w-56 shrink-0">
                <Field label={t('applications.roles.key')}>
                  <TextFieldInput
                    label={t('applications.roles.key')}
                    value={row.key}
                    placeholder="payments.operate"
                    disabled={!canManage}
                    invalid={row.key.length > 0 && !isApplicationPermissionKey(row.key)}
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={(value) =>
                      setDraft(
                        draft.map((item, i) =>
                          i === index ? { ...item, key: value.trim() } : item,
                        ),
                      )
                    }
                  />
                </Field>
              </View>
              <View className="min-w-0 flex-1">
                <Field label={t('applications.roles.description')}>
                  <TextFieldInput
                    label={t('applications.roles.description')}
                    value={row.description}
                    placeholder={t('applications.roles.descriptionPlaceholder')}
                    disabled={!canManage}
                    autoCapitalize="sentences"
                    onChangeText={(value) =>
                      setDraft(
                        draft.map((item, i) =>
                          i === index ? { ...item, description: value } : item,
                        ),
                      )
                    }
                  />
                </Field>
              </View>
              {canManage ? (
                <Button
                  appearance="plain"
                  onPress={() => setDraft(draft.filter((_, i) => i !== index))}
                >
                  {t('applications.roles.remove')}
                </Button>
              ) : null}
            </View>
          ))}

          {removed.length > 0 ? (
            <Admonition type="warning">
              <Text variant="body-2-semibold">
                {t('applications.roles.retiresTitle', {
                  keys: removed.map((row) => row.key).join(', '),
                })}
              </Text>
              {'\n'}
              {t('applications.roles.retiresBody')}
            </Admonition>
          ) : null}
        </View>
      </CardBody>
      {canManage ? (
        <CardFooter>
          <Button
            appearance="outline"
            onPress={() => setDraft([...draft, { key: '', description: '' }])}
          >
            {t('applications.roles.add')}
          </Button>
          <Button
            loading={declare.isPending}
            disabled={!dirty || invalid || duplicate}
            onPress={() => void save()}
          >
            {t('applications.roles.save')}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

function GrantsPanel({
  appId,
  keys,
  grants,
  canManage,
}: {
  appId: string;
  keys: string[];
  grants: Array<{
    id: string;
    permission: string;
    userId: string;
    username: string | null;
    grantedAt: string;
    grantReason: string | null;
  }>;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState('');
  const [reason, setReason] = useState('');
  const grant = useGrantApplicationPermission();
  const revoke = useRevokeApplicationRoleGrant();

  const submit = async () => {
    try {
      await grant.mutateAsync({
        appId,
        username: username.trim().replace(/^@/, ''),
        permission,
        reason: reason.trim() || undefined,
      });
      setUsername('');
      setReason('');
      toast.success(t('applications.roles.granted'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.roles.grantFailed')));
    }
  };

  const revokeGrant = async (grantId: string) => {
    try {
      await revoke.mutateAsync({ appId, grantId });
      toast.success(t('applications.roles.revoked'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.roles.revokeFailed')));
    }
  };

  return (
    <View className="gap-6">
      <Card appearance="outline">
        <CardHeader>
          <CardTitle>{t('applications.roles.peopleTitle')}</CardTitle>
          <CardDescription>{t('applications.roles.peopleBody')}</CardDescription>
        </CardHeader>
        {grants.length === 0 ? (
          <CardBody>
            <Text className="text-sm text-muted-foreground">{t('applications.roles.nobody')}</Text>
          </CardBody>
        ) : (
          grants.map((item) => (
            <Item
              key={item.id}
              title={
                <>
                  {item.username ? `@${item.username}` : item.userId} <Code>{item.permission}</Code>
                </>
              }
              subtitle={`${t('applications.roles.since', {
                date: new Date(item.grantedAt).toLocaleDateString(),
              })}${item.grantReason ? ` · ${item.grantReason}` : ''}`}
              trailing={
                canManage ? (
                  <Button
                    appearance="outline"
                    size="sm"
                    disabled={revoke.isPending}
                    onPress={() => void revokeGrant(item.id)}
                  >
                    {t('applications.roles.revoke')}
                  </Button>
                ) : undefined
              }
            />
          ))
        )}
      </Card>

      {canManage && keys.length > 0 ? (
        <Card appearance="outline">
          <CardHeader>
            <CardTitle>{t('applications.roles.grantTitle')}</CardTitle>
            <CardDescription>{t('applications.roles.grantHint')}</CardDescription>
          </CardHeader>
          <CardBody>
            <View className="gap-4">
              <Field label={t('applications.roles.username')}>
                <TextFieldInput
                  label={t('applications.roles.username')}
                  value={username}
                  placeholder="@username"
                  onChangeText={setUsername}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </Field>
              <Field label={t('applications.roles.permission')}>
                <Select value={permission} onValueChange={setPermission}>
                  <SelectTrigger label={t('applications.roles.permission')}>
                    <SelectValue placeholder={t('applications.roles.permissionPlaceholder')} />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent
                    label={t('applications.roles.permission')}
                    items={keys.map((key) => ({ value: key, label: key }))}
                    renderItem={(item) => (
                      <SelectItem value={item.value} label={item.label}>
                        <SelectItemIndicator />
                        <SelectItemText>{item.label}</SelectItemText>
                      </SelectItem>
                    )}
                  />
                </Select>
              </Field>
              <Field label={t('applications.roles.reason')}>
                <TextFieldInput
                  label={t('applications.roles.reason')}
                  value={reason}
                  placeholder={t('applications.roles.reasonPlaceholder')}
                  autoCapitalize="sentences"
                  onChangeText={setReason}
                />
              </Field>
            </View>
          </CardBody>
          <CardFooter>
            <Button
              loading={grant.isPending}
              disabled={!username.trim() || !permission}
              onPress={() => void submit()}
            >
              {t('applications.roles.grant')}
            </Button>
          </CardFooter>
        </Card>
      ) : null}
    </View>
  );
}
