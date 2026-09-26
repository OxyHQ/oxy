/**
 * Linking Commons to a passkey account (ADR 0029 D3), auth.oxy.so's
 * `/link-commons`:
 *
 *   QR → Commons scans and signs with its key → both screens show the same
 *   code → the person confirms here with the passkey → linked
 *
 * Afterwards the account is self-custodied: its root is the key Commons holds,
 * its recovery email is deleted, and its phrase in Commons is how it gets back
 * in. The passkey keeps signing in on the web. The page must be signed in as
 * the account; the host renders sign-in first.
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Button } from '@oxy.so/bloom/button';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { deriveIdentityLinkCode } from '@oxy.so/core';
import type { IdentityLinkCreateResponse } from '@oxy.so/contracts';
import { useOxy } from '../../context/OxyContext';
import { PASSKEY_UNSUPPORTED_MESSAGE } from '../../context/passkeyFlow';
import { useI18n } from '../../hooks/useI18n';
import { isPasskeySupported, runAuthenticationCeremony } from '../../../webauthn/passkeyClient';
import { OxyAuthScreen, OxyAuthScreenHeader } from './OxyAuthScreen';
import { AccountFlowAction, AccountFlowErrorLine, AccountFlowNote, describeAccountFlowError } from './accountFlowParts';

/** How often the page asks whether Commons has signed. */
export const IDENTITY_LINK_POLL_MS = 2000;

/** High-contrast, un-themed on purpose: scan reliability. */
const QR_PLATE_BG = '#FFFFFF';
const QR_FOREGROUND = '#000000';
const QR_SIZE = 200;

type Step =
  | { name: 'opening' }
  | { name: 'qr'; link: IdentityLinkCreateResponse }
  | { name: 'matching'; link: IdentityLinkCreateResponse; code: string }
  | { name: 'expired' }
  | { name: 'done' };

export interface OxyLinkCommonsPanelProps {
  /** Commons is linked. */
  onLinked?: () => void;
}

export const OxyLinkCommonsPanel: React.FC<OxyLinkCommonsPanelProps> = ({ onLinked }) => {
  const theme = useTheme();
  const { t } = useI18n();
  const { user, oxyServices } = useOxy();
  const [step, setStep] = useState<Step>({ name: 'opening' });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alreadyLinked = Boolean(user?.publicKey);

  const open = useCallback(() => {
    setError(null);
    setStep({ name: 'opening' });
    oxyServices
      .createIdentityLink()
      .then((link) => setStep({ name: 'qr', link }))
      .catch((reason: unknown) => {
        setError(describeAccountFlowError(reason, t));
        setStep({ name: 'expired' });
      });
  }, [oxyServices, t]);

  // One request per visit, opened once the page knows the account has no root.
  const opened = useRef(false);
  useEffect(() => {
    if (alreadyLinked || opened.current) return;
    opened.current = true;
    open();
  }, [alreadyLinked, open]);

  // While the QR shows, ask whether Commons has signed; a request only lives a
  // few minutes, and an expired one says so instead of waiting forever.
  const link = step.name === 'qr' ? step.link : null;
  useEffect(() => {
    if (!link) return;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      if (Date.now() >= link.expiresAt) {
        setStep({ name: 'expired' });
        return;
      }
      try {
        const state = await oxyServices.getIdentityLink(link.linkId);
        if (stopped) return;
        if (state.status === 'signed' && state.publicKey) {
          setStep({ name: 'matching', link, code: deriveIdentityLinkCode(link.linkId, state.publicKey) });
          return;
        }
        if (state.status === 'cancelled') {
          setStep({ name: 'expired' });
          return;
        }
      } catch {
        // A missed poll is retried on the next tick.
      }
      if (!stopped) timer = setTimeout(() => void poll(), IDENTITY_LINK_POLL_MS);
    };
    let timer = setTimeout(() => void poll(), IDENTITY_LINK_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [link, oxyServices]);

  // The ceremony opens the browser's passkey prompt, so it starts from the press.
  const confirm = (confirmed: IdentityLinkCreateResponse) => {
    if (pending) return;
    setError(null);
    setPending(true);
    (async () => {
      if (!isPasskeySupported()) throw new Error(PASSKEY_UNSUPPORTED_MESSAGE);
      const options = await oxyServices.getIdentityLinkAssertionOptions(confirmed.linkId, confirmed.challenge);
      const assertion = await runAuthenticationCeremony(options);
      await oxyServices.completeIdentityLink(confirmed.linkId, assertion);
      setStep({ name: 'done' });
      onLinked?.();
    })()
      .catch((reason: unknown) => setError(describeAccountFlowError(reason, t)))
      .finally(() => setPending(false));
  };

  const cancel = (cancelled: IdentityLinkCreateResponse) => {
    void oxyServices.cancelIdentityLink(cancelled.linkId).catch(() => undefined);
    setStep({ name: 'expired' });
  };

  if (alreadyLinked) {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader title={t('linkCommons.title')} description={t('linkCommons.already')} />
      </OxyAuthScreen>
    );
  }

  switch (step.name) {
    case 'done':
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader title={t('linkCommons.doneTitle')} description={t('linkCommons.done')} />
        </OxyAuthScreen>
      );
    case 'expired':
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader title={t('linkCommons.title')} description={t('linkCommons.expired')} />
          {error ? <AccountFlowErrorLine message={error} /> : null}
          <AccountFlowAction label={t('linkCommons.renew')} onPress={open} pending={false} testID="link-commons-renew" />
        </OxyAuthScreen>
      );
    case 'matching':
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader title={t('linkCommons.compareTitle')} description={t('linkCommons.compare')} />
          <Text
            accessibilityLabel={step.code.split('').join(' ')}
            style={[styles.code, { color: theme.colors.text }]}
            testID="link-commons-code"
          >
            {`${step.code.slice(0, 3)} ${step.code.slice(3)}`}
          </Text>
          {error ? <AccountFlowErrorLine message={error} /> : null}
          <AccountFlowAction label={t('linkCommons.confirm')} onPress={() => confirm(step.link)} pending={pending} testID="link-commons-confirm" />
          <Button appearance="plain" tone="neutral" size="lg" fullWidth disabled={pending} onPress={() => cancel(step.link)} testID="link-commons-cancel">
            {t('linkCommons.cancel')}
          </Button>
        </OxyAuthScreen>
      );
    case 'qr':
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader title={t('linkCommons.title')} description={t('linkCommons.subtitle')} />
          <View style={styles.plateRow}>
            <View style={[styles.plate, { borderColor: theme.colors.border }]} testID="link-commons-qr">
              <QRCode value={step.link.qrPayload} size={QR_SIZE} backgroundColor={QR_PLATE_BG} color={QR_FOREGROUND} />
            </View>
          </View>
          <AccountFlowNote>{t('linkCommons.scan')}</AccountFlowNote>
          <AccountFlowNote>{t('linkCommons.waiting')}</AccountFlowNote>
          <Button appearance="plain" tone="neutral" size="lg" fullWidth onPress={() => cancel(step.link)} testID="link-commons-cancel">
            {t('linkCommons.cancel')}
          </Button>
        </OxyAuthScreen>
      );
    default:
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader title={t('linkCommons.title')} description={t('linkCommons.subtitle')} />
          <View style={styles.plateRow}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        </OxyAuthScreen>
      );
  }
};

const styles = StyleSheet.create({
  plateRow: {
    alignItems: 'center',
  },
  plate: {
    padding: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: QR_PLATE_BG,
  },
  code: {
    fontSize: 40,
    lineHeight: 48,
    fontWeight: '700',
    letterSpacing: 4,
    textAlign: 'center',
  },
});
