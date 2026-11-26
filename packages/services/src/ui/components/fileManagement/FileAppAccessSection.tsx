import type React from 'react';
import { useCallback, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { surfaces } from '@oxy.so/bloom/surfaces';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import type { FileApplicationAccess } from '@oxy.so/core';
import { useI18n } from '../../hooks/useI18n';
import { useFileAppAccess, useRevokeFileAppAccess } from '../../hooks/queries/useFileQueries';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const APP_ICON_SIZE = 32;

interface FileAppAccessSectionProps {
  fileId: string;
}

/**
 * "Apps with access" (ADR 0043 stage 4c): the applications that can open this
 * file on their own — one that stored it for the person (`upload`), one the
 * person attached it to (`link`) — each with a Revoke action behind a
 * confirmation. Revoking stops the application reading the file and every
 * playback it started; the row leaves the list at once and comes back if the
 * revoke fails. Shown only on the owner's own file.
 */
export const FileAppAccessSection: React.FC<FileAppAccessSectionProps> = ({ fileId }) => {
  const styles = useStyles();
  const { t } = useI18n();
  const { colors } = useTheme();
  const access = useFileAppAccess(fileId);
  const apps = access.value?.apps;
  const isLoading = access.isLoading;
  const isError = access.status === 'error';
  const revoke = useRevokeFileAppAccess();
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const confirmRevoke = useCallback(
    async (app: FileApplicationAccess) => {
      const confirmed = await surfaces.confirm({
        title: t('fileManagement.appAccess.confirm.title', { name: app.name }),
        description: t('fileManagement.appAccess.confirm.message', { name: app.name }),
        confirmLabel: t('fileManagement.appAccess.revoke'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!confirmed) return;
      setRevokingId(app.applicationId);
      try {
        await revoke.run({ fileId, applicationId: app.applicationId });
        toast.success(t('fileManagement.appAccess.toasts.revoked', { name: app.name }));
      } catch {
        toast.error(t('fileManagement.appAccess.toasts.revokeFailed', { name: app.name }));
      } finally {
        setRevokingId(null);
      }
    },
    [fileId, revoke, t],
  );

  const viaText = (app: FileApplicationAccess): string =>
    app.via.map((via) => t(`fileManagement.appAccess.via.${via}`)).join(' · ');

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t('fileManagement.appAccess.title')}</Text>
      <Text style={styles.mutedText}>{t('fileManagement.appAccess.description')}</Text>
      {isLoading ? (
        <ActivityIndicator color={colors.primary} />
      ) : isError ? (
        <Text style={styles.mutedText2}>{t('fileManagement.appAccess.loadError')}</Text>
      ) : !apps || apps.length === 0 ? (
        <Text style={styles.mutedText2}>{t('fileManagement.appAccess.empty')}</Text>
      ) : (
        <GroupedSection>
          {apps.map((app) => (
            <GroupedSectionItem
              key={app.applicationId}
              icon={<Avatar source={app.icon} name={app.name} size={APP_ICON_SIZE} />}
              title={app.name}
              description={viaText(app)}
              showChevron={false}
              rightElement={
                <Button
                  appearance="subtle"
                  tone="danger"
                  size="sm"
                  loading={revokingId === app.applicationId}
                  disabled={revokingId !== null}
                  accessibilityLabel={t('fileManagement.appAccess.a11y.revoke', { name: app.name })}
                  onPress={() => {
                    void confirmRevoke(app);
                  }}
                >
                  {t('fileManagement.appAccess.revoke')}
                </Button>
              }
            />
          ))}
        </GroupedSection>
      )}
    </View>
  );
};

const useStyles = createTokenStyles((t) => ({
  container: { marginBottom: 24, width: '100%' },
  title: { marginBottom: 4, fontSize: 16, fontWeight: 600, color: t.foreground },
  mutedText: { marginBottom: 12, fontSize: 14, color: t.mutedForeground },
  mutedText2: { fontSize: 14, color: t.mutedForeground },
}));
