import React, { useCallback, useMemo, useState } from 'react';
import { Text } from '@oxy.so/bloom/typography';
import { Admonition } from '@oxy.so/bloom/admonition';
import { bloomToneFor } from '@/lib/civic/card-presentation';
import { Card } from '@oxy.so/bloom/card';
import { Badge } from '@oxy.so/bloom/badge';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { fullWidthControl } from '@/constants/styles';
import { Button } from '@oxy.so/bloom/button';
import { View, StyleSheet, TextInput, TouchableOpacity, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import {
  Screen,
  StackHeader,
  Section,
  GroupedList,
  ListRow,
  SessionGate,
  LoadingState,
  STATE_MIN_HEIGHT,
} from '@/components/ui';
import {
  useMyNode,
  useRegisterNode,
  useProvisionVault,
  useRemoveNode,
  useSyncNode,
} from '@/hooks/useNode';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { useTranslation } from '@/lib/i18n';
import type { UserNodeMode, UserNodeStatus } from '@oxy.so/core';
import type { CivicTone } from '@/lib/civic/card-presentation';
import { Icons, type IconName } from '@/constants/icons';

/** A node endpoint is acceptable to send when it parses as a public HTTPS URL. */
function isValidEndpoint(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https:\/\/.+/iu.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** A node public key is acceptable when it is a non-trivial even-length hex string. */
function isValidPublicKey(value: string): boolean {
  const trimmed = value.trim();
  return /^[0-9a-f]+$/iu.test(trimmed) && trimmed.length >= 32 && trimmed.length % 2 === 0;
}

/** Map the liveness badge to a tone + icon + label key. */
function statusMeta(status: UserNodeStatus['status']): {
  tone: CivicTone;
  icon: IconName;
  labelKey: string;
} {
  switch (status) {
    case 'active':
      return { tone: 'positive', icon: 'verified', labelKey: 'civic.nodes.status.active' };
    case 'unreachable':
      return { tone: 'caution', icon: 'alert', labelKey: 'civic.nodes.status.unreachable' };
    case 'revoked':
    default:
      return { tone: 'danger', icon: 'offline', labelKey: 'civic.nodes.status.revoked' };
  }
}

/**
 * "Your data node" — connect / view the user's personal data node (Fase 5).
 *
 * The node is where the user's signed identity and records live; Oxy keeps a
 * fast, verified copy so reads stay instant while the node remains the source of
 * truth. Three states: a loading/error centerpiece, a "no node" explainer with
 * the two ways to set one up (a recommended managed vault and an advanced
 * connect-your-own form), and a "has node" status view with sync + disconnect
 * actions. The two sovereignty mutations (connect, disconnect) and the managed
 * provision are biometric-gated; "Sync now" is a best-effort hint.
 */
export default function NodeScreen() {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();
  const relativeTime = useRelativeTime();

  // Self-hosting a node signs a `type:'node'` record with the on-device
  // identity key, which only exists in the native Oxy app. On web we hide that
  // path and steer the user to the custodial managed vault instead.
  const isWeb = Platform.OS === 'web';

  const query = useMyNode();
  const node = query.data;

  const register = useRegisterNode(t('civic.nodes.form.biometricReason'));
  const provision = useProvisionVault(t('civic.nodes.provision.biometricReason'));
  const remove = useRemoveNode(t('civic.nodes.disconnect.biometricReason'));
  const syncNode = useSyncNode();

  const [formOpen, setFormOpen] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [mode, setMode] = useState<UserNodeMode>('pull');
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/(settings)');
  }, [router]);

  const endpointValid = useMemo(() => isValidEndpoint(endpoint), [endpoint]);
  const publicKeyValid = useMemo(() => isValidPublicKey(publicKey), [publicKey]);

  const registerBusy = register.state === 'working';
  const provisionBusy = provision.state === 'working';
  const removeBusy = remove.state === 'working';
  const syncing = syncNode.state === 'working';

  const handleRegister = useCallback(() => {
    if (!endpointValid || !publicKeyValid) return;
    void register.register({ endpoint: endpoint.trim(), nodePublicKey: publicKey.trim(), mode });
  }, [endpointValid, publicKeyValid, register, endpoint, publicKey, mode]);

  const openForm = useCallback(() => {
    // The self-host register flow is native-only; it must never open on web.
    if (isWeb) return;
    register.reset();
    setFormOpen(true);
  }, [isWeb, register]);

  const closeForm = useCallback(() => {
    register.reset();
    setFormOpen(false);
  }, [register]);

  const handleProvisionDone = useCallback(() => provision.reset(), [provision]);
  const handleRegisterDone = useCallback(() => {
    register.reset();
    setFormOpen(false);
  }, [register]);

  const handleDisconnect = useCallback(() => {
    setConfirmingDisconnect(false);
    void remove.remove();
  }, [remove]);

  /* ------------------------------- Interstitials ------------------------------ */

  if (provision.state === 'done') {
    return (
      <Screen gap={24}>
        <StackHeader title={t('civic.nodes.title')} onBack={handleBack} backAccessibilityLabel={t('common.back')} />
        <EmptyState
          illustration={<Icons.shieldCheck size="3xl" fill={colors.success} />}
          title={t('civic.nodes.provision.done.title')}
          description={t('civic.nodes.provision.done.body')}
          footer={
            <View className="items-center mt-space-4">
              <Button appearance="solid" tone="accent" size="lg" onPress={handleProvisionDone}>{t('common.done')}</Button>
            </View>
          }
          minHeight={STATE_MIN_HEIGHT}
        />
      </Screen>
    );
  }

  if (register.state === 'done') {
    return (
      <Screen gap={24}>
        <StackHeader title={t('civic.nodes.title')} onBack={handleBack} backAccessibilityLabel={t('common.back')} />
        <EmptyState
          illustration={<Icons.node size="3xl" fill={colors.success} />}
          title={t('civic.nodes.register.done.title')}
          description={t('civic.nodes.register.done.body')}
          footer={
            <View className="items-center mt-space-4">
              <Button appearance="solid" tone="accent" size="lg" onPress={handleRegisterDone}>{t('common.done')}</Button>
            </View>
          }
          minHeight={STATE_MIN_HEIGHT}
        />
      </Screen>
    );
  }

  /* ------------------------------- No-node view ------------------------------ */

  const renderNoNode = () => (
    <>
      <Section title={t('civic.nodes.intro.title')}>
        <Text style={[styles.intro, { color: colors.text }]}>
          {t('civic.nodes.intro.body')}
        </Text>
      </Section>

      <Section title={t('civic.nodes.how.title')}>
        <GroupedList>
          <ListRow
            icon="credential"
            title={t('civic.nodes.how.sourceOfTruth')}
            subtitle={t('civic.nodes.how.sourceOfTruthDesc')}
          />
          <ListRow
            icon="flash"
            title={t('civic.nodes.how.fastCopy')}
            subtitle={t('civic.nodes.how.fastCopyDesc')}
          />
          <ListRow
            icon="share"
            title={t('civic.nodes.how.portable')}
            subtitle={t('civic.nodes.how.portableDesc')}
          />
        </GroupedList>
      </Section>

      <Section title={t('civic.nodes.choose.title')} subtitle={t('civic.nodes.choose.subtitle')}>
        <View className="gap-space-12">
          <Card
            appearance="subtle"
            tone="accent"
            radius="radius-24"
            style={styles.softSurface}
            onPress={provisionBusy ? undefined : () => void provision.provision()}
            accessibilityLabel={t('civic.nodes.managed.cta')}
          >
            <View className="flex-row items-center gap-space-12">
              <View className="flex-1 gap-space-4">
                <Text style={[styles.choiceTitle, { color: colors.tint }]}>
                  {t('civic.nodes.managed.cta')}
                </Text>
                <Text style={[styles.choiceSubtitle, { color: colors.textSecondary }]}>
                  {t('civic.nodes.managed.ctaSubtitle')}
                </Text>
              </View>
              {provisionBusy && (
                <Text style={[styles.choiceBusy, { color: colors.tint }]}>
                  {t('civic.nodes.provision.submitting')}
                </Text>
              )}
            </View>
          </Card>

          {isWeb ? (
            <Admonition type="info">
              {t('civic.nodes.selfHost.webUnavailable')}
            </Admonition>
          ) : (
            <>
              <Button appearance="outline" tone="accent" size="lg" icon={Icons.terminal} onPress={openForm} disabled={provisionBusy} style={fullWidthControl}>{t('civic.nodes.selfHost.cta')}</Button>
              <Text style={[styles.choiceHint, { color: colors.textSecondary }]}>
                {t('civic.nodes.selfHost.ctaSubtitle')}
              </Text>
            </>
          )}
        </View>
      </Section>

      <Admonition type="info">
        {t('civic.nodes.managed.note')}
      </Admonition>

      {provision.biometricFailed && (
        <Text style={[styles.inlineWarn, { color: colors.warning }]}>
          {t('civic.nodes.provision.biometricFailed')}
        </Text>
      )}

      {provision.state === 'error' && (
        <Admonition type="error">
          {t(`civic.nodes.errors.${provision.errorCode ?? 'generic'}`)}
        </Admonition>
      )}
    </>
  );

  /* -------------------------------- Form view -------------------------------- */

  const renderForm = () => (
    <>
      <Section title={t('civic.nodes.form.title')} subtitle={t('civic.nodes.form.subtitle')}>
        <View className="gap-space-8">
          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>
            {t('civic.nodes.form.endpointLabel')}
          </Text>
          <TextInput
            value={endpoint}
            onChangeText={setEndpoint}
            editable={!registerBusy}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder={t('civic.nodes.form.endpointPlaceholder')}
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel={t('civic.nodes.form.endpointLabel')}
            style={[styles.input, { color: colors.text, borderColor: colors.border }]}
          />
          <Text style={[styles.fieldHint, { color: colors.textSecondary }]}>
            {endpoint.trim().length > 0 && !endpointValid
              ? t('civic.nodes.form.endpointInvalid')
              : t('civic.nodes.form.endpointHint')}
          </Text>
        </View>

        <View className="gap-space-8">
          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>
            {t('civic.nodes.form.publicKeyLabel')}
          </Text>
          <TextInput
            value={publicKey}
            onChangeText={setPublicKey}
            editable={!registerBusy}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t('civic.nodes.form.publicKeyPlaceholder')}
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel={t('civic.nodes.form.publicKeyLabel')}
            style={[styles.input, { color: colors.text, borderColor: colors.border }]}
          />
          <Text style={[styles.fieldHint, { color: colors.textSecondary }]}>
            {publicKey.trim().length > 0 && !publicKeyValid
              ? t('civic.nodes.form.publicKeyInvalid')
              : t('civic.nodes.form.publicKeyHint')}
          </Text>
        </View>
      </Section>

      <Section title={t('civic.nodes.form.modeLabel')}>
        <View className="flex-row gap-space-8">
          {(['pull', 'push'] as const).map((option) => {
            const selected = option === mode;
            return (
              <TouchableOpacity
                key={option}
                onPress={() => setMode(option)}
                disabled={registerBusy}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={[
                  styles.modeChip,
                  { borderColor: selected ? colors.tint : colors.border },
                  selected && { backgroundColor: colors.primarySubtle },
                ]}
              >
                <Text style={[styles.modeChipText, { color: selected ? colors.tint : colors.text }]}>
                  {t(`civic.nodes.form.mode${option === 'pull' ? 'Pull' : 'Push'}`)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={[styles.fieldHint, { color: colors.textSecondary }]}>
          {t(`civic.nodes.form.mode${mode === 'pull' ? 'Pull' : 'Push'}Desc`)}
        </Text>
      </Section>

      {register.biometricFailed && (
        <Text style={[styles.inlineWarn, { color: colors.warning }]}>
          {t('civic.nodes.form.biometricFailed')}
        </Text>
      )}

      {register.state === 'error' && (
        <Admonition type="error">
          {t(`civic.nodes.errors.${register.errorCode ?? 'generic'}`)}
        </Admonition>
      )}

      <View className="gap-space-12">
        <Button appearance="solid" tone="accent" size="lg" icon={Icons.personhood} onPress={handleRegister} loading={registerBusy} disabled={!endpointValid || !publicKeyValid || registerBusy} style={fullWidthControl}>{t('civic.nodes.form.cta')}</Button>
        {registerBusy && (
          <Text style={[styles.centerMuted, { color: colors.textSecondary }]}>
            {t('civic.nodes.form.submitting')}
          </Text>
        )}
        <Button appearance="outline" tone="accent" size="lg" onPress={closeForm} disabled={registerBusy} style={fullWidthControl}>{t('civic.nodes.form.cancel')}</Button>
      </View>
    </>
  );

  /* ------------------------------- Has-node view ----------------------------- */

  const renderHasNode = (current: UserNodeStatus) => {
    const meta = statusMeta(current.status);
    const isManaged = current.managed || current.controller === 'oxy';

    return (
      <>
        {/* Status hero */}
        <View style={styles.hero}>
          <Badge
            appearance="subtle"
            tone={bloomToneFor(meta.tone)}
            size="label-medium"
            icon={Icons[meta.icon]}
            content={t(meta.labelKey)}
          />
          <Text style={[styles.heroType, { color: colors.text }]}>
            {t(isManaged ? 'civic.nodes.type.managed' : 'civic.nodes.type.selfHosted')}
          </Text>
          <Text style={[styles.heroTypeDesc, { color: colors.textSecondary }]}>
            {t(isManaged ? 'civic.nodes.type.managedDesc' : 'civic.nodes.type.selfHostedDesc')}
          </Text>
        </View>

        {current.status === 'unreachable' && (
          <Admonition type="warning">
            {current.lastError
              ? t('civic.nodes.unreachableNote', { reason: current.lastError })
              : t('civic.nodes.unreachableNoteGeneric')}
          </Admonition>
        )}

        {current.status === 'revoked' && (
          <Admonition type="error">
            {t('civic.nodes.revokedNote')}
          </Admonition>
        )}

        {/* Endpoint — selectable, full address */}
        <Section title={t('civic.nodes.details.title')}>
          <Card appearance="subtle" tone="neutral" radius="radius-24" style={styles.softSurface}>
            <Text style={[styles.endpointCaption, { color: colors.textSecondary }]}>
              {t('civic.nodes.details.endpoint')}
            </Text>
            <Text selectable style={[styles.endpointValue, { color: colors.text }]}>
              {current.endpoint}
            </Text>
          </Card>

          <GroupedList>
            <ListRow
              icon="sort"
              title={t('civic.nodes.details.mode')}
              value={t(current.mode === 'pull' ? 'civic.nodes.mode.pull' : 'civic.nodes.mode.push')}
            />
            <ListRow
              icon="node"
              title={t('civic.nodes.details.lastSeen')}
              value={relativeTime(current.lastSeenAt, t('civic.nodes.details.never'))}
            />
            <ListRow
              icon="sync"
              title={t('civic.nodes.details.lastSynced')}
              value={relativeTime(current.lastSyncedAt, t('civic.nodes.details.never'))}
            />
          </GroupedList>
        </Section>

        {/* Actions */}
        <Section title={t('civic.nodes.actions.title')}>
          <GroupedList>
            <ListRow
              icon="sync"
              title={syncing ? t('civic.nodes.actions.syncing') : t('civic.nodes.actions.sync')}
              subtitle={t('civic.nodes.actions.syncDesc')}
              onPress={syncing ? undefined : () => void syncNode.sync()}
              disabled={syncing}
            />
            <ListRow
              icon="blocked"
              title={t('civic.nodes.actions.disconnect')}
              subtitle={t('civic.nodes.actions.disconnectDesc')}
              onPress={removeBusy ? undefined : () => setConfirmingDisconnect(true)}
              disabled={removeBusy}
              destructive
            />
          </GroupedList>
        </Section>

        {syncNode.state === 'done' && (
          <Text style={[styles.inlineNote, { color: colors.success }]}>
            {t('civic.nodes.actions.synced')}
          </Text>
        )}
        {syncNode.state === 'error' && (
          <Text style={[styles.inlineWarn, { color: colors.warning }]}>
            {t('civic.nodes.actions.syncFailed')}
          </Text>
        )}

        {/* Inline disconnect confirm */}
        {confirmingDisconnect && (
          <Section title={t('civic.nodes.disconnect.confirmTitle')}>
            <Admonition type="error">
              {t('civic.nodes.disconnect.confirmBody')}
            </Admonition>
            <View className="flex-row gap-space-12 mt-space-4">
              <Button appearance="outline" tone="accent" size="lg" onPress={() => setConfirmingDisconnect(false)} disabled={removeBusy} style={[fullWidthControl, styles.confirmButton]}>{t('civic.nodes.disconnect.cancel')}</Button>
              <Button appearance="solid" tone="danger" size="lg" icon={Icons.personhood} onPress={handleDisconnect} loading={removeBusy} style={[fullWidthControl, styles.confirmButton]}>{t('civic.nodes.disconnect.confirmCta')}</Button>
            </View>
          </Section>
        )}

        {remove.biometricFailed && (
          <Text style={[styles.inlineWarn, { color: colors.warning }]}>
            {t('civic.nodes.disconnect.biometricFailed')}
          </Text>
        )}
        {remove.state === 'error' && (
          <Admonition type="error">
            {t(`civic.nodes.errors.${remove.errorCode ?? 'generic'}`)}
          </Admonition>
        )}
      </>
    );
  };

  /* ---------------------------------- Body ----------------------------------- */

  const renderBody = () => {
    if (query.isPending && node === undefined) {
      return <LoadingState description={t('civic.nodes.loading')} />;
    }

    if (query.isError && node === undefined) {
      return (
        <EmptyState
          icon={Icons.alert}
          title={t('civic.nodes.error.title')}
          description={t('civic.nodes.error.body')}
          footer={
            <View className="items-center mt-space-4">
              <Button appearance="solid" tone="accent" size="lg" onPress={() => query.refetch()}>{t('common.retry')}</Button>
            </View>
          }
          minHeight={STATE_MIN_HEIGHT}
        />
      );
    }

    if (node) {
      return renderHasNode(node);
    }

    return formOpen ? renderForm() : renderNoNode();
  };

  return (
    <Screen gap={24} refreshing={query.isRefetching} onRefresh={() => query.refetch()}>
      <StackHeader
        title={t('civic.nodes.title')}
        onBack={formOpen ? closeForm : handleBack}
        backAccessibilityLabel={t('common.back')}
      />
      <SessionGate>{renderBody()}</SessionGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  /**
   * The padding the retired `SoftSurface` applied. Bloom's `Card` draws the
   * surface — fill, corner, press feedback — and leaves its inside to the
   * caller, which is why `CardBody` exists; this content is not a header/body/
   * footer stack, so it takes the padding directly.
   */
  softSurface: { padding: 18 },
  intro: {
    fontSize: 15,
    lineHeight: 22,
  },
  choiceTitle: {
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  choiceSubtitle: {
    fontSize: 14,
    lineHeight: 19,
  },
  choiceBusy: {
    fontSize: 13,
    fontWeight: '600',
  },
  choiceHint: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 2,
  },
  inlineWarn: {
    fontSize: 13,
    lineHeight: 18,
  },
  inlineNote: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  field: {
    gap: 8,
  },
  fieldLabel: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  fieldHint: {
    fontSize: 13,
    lineHeight: 18,
  },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 15,
  },
  modeChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: 999,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
  },
  modeChipText: {
    fontSize: 14,
    fontWeight: '600',
  },
  centerMuted: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  hero: {
    gap: 10,
    alignItems: 'flex-start',
  },
  heroType: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  heroTypeDesc: {
    fontSize: 14,
    lineHeight: 20,
  },
  endpointCaption: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  endpointValue: {
    fontSize: 14,
    lineHeight: 20,
  },
  confirmButton: {
    flex: 1,
  },
});
