/**
 * The account's authenticator app (TOTP), from its settings:
 *
 *   off  → "Set up" → the QR (`otpauth://`) and its setup key → the app's
 *          first code, confirmed like any sensitive change → the backup codes,
 *          shown once
 *   on   → new backup codes, or turn it off — each confirmed like any
 *          sensitive change (with the authenticator's code too)
 *
 * Once on, every sign-in (email code, link or password) asks for the app's code
 * as a second step, or a backup code.
 */

import type React from 'react';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { CodeBlock } from '@oxy.so/bloom/code';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { TOTP_DIGITS, type TotpEnrollResponse } from '@oxy.so/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '../../context/OxyContext';
import { useSignInMethods } from '../../hooks/queries/useAuthMethods';
import { queryKeys } from '../../hooks/queries/queryKeys';
import { useI18n } from '../../hooks/useI18n';
import { copyText } from '../../utils/clipboard';
import { SubtleLink } from '../authChooser/primitives';
import { OxyAuthLoading, OxyAuthScreen, OxyAuthScreenHeader } from './OxyAuthScreen';
import { ReauthStep } from './ReauthStep';
import {
  AccountFlowAction,
  AccountFlowCodeField,
  AccountFlowErrorLine,
  AccountFlowNote,
  AccountFlowProgress,
  describeSignInError,
} from './accountFlowParts';

/** High-contrast, un-themed on purpose: scan reliability. */
const QR_PLATE_BG = '#FFFFFF';
const QR_FOREGROUND = '#000000';
const QR_SIZE = 184;

type Step =
  | { name: 'status' }
  | { name: 'enroll'; enrollment: TotpEnrollResponse }
  | { name: 'regenerate' }
  | { name: 'disable' }
  /** `enrolling`: the last step of turning it on, rather than new codes for one that is on. */
  | { name: 'codes'; codes: string[]; enrolling: boolean };

export interface OxyAuthenticatorPanelProps {
  /** The person is done here (after saving backup codes, or turning it off). */
  onDone?: () => void;
}

export const OxyAuthenticatorPanel: React.FC<OxyAuthenticatorPanelProps> = ({ onDone }) => {
  const theme = useTheme();
  const { t } = useI18n();
  const { oxyServices, user } = useOxy();
  const queryClient = useQueryClient();
  const keyed = Boolean(user?.publicKey);
  const methods = useSignInMethods({ enabled: !keyed });
  const [step, setStep] = useState<Step>({ name: 'status' });
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.signInMethods.all });

  if (keyed) {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader title={t('signInSecurity.totp.title')} description={t('linkCommons.already')} />
      </OxyAuthScreen>
    );
  }
  if (!methods.data) return <OxyAuthLoading />;
  const { hasPassword, totpEnabled, backupCodesRemaining } = methods.data;

  const setUp = () => {
    if (pending) return;
    setError(null);
    setPending(true);
    oxyServices
      .auth.totp.enroll()
      .then((enrollment) => {
        setCode('');
        setStep({ name: 'enroll', enrollment });
      })
      .catch((reason: unknown) => setError(describeSignInError(reason, t)))
      .finally(() => setPending(false));
  };

  const back = { label: t('common.cancel'), onPress: () => setStep({ name: 'status' }) };
  // Turning it on is two steps: scan and confirm, then save the backup codes.
  const enrolSteps = [t('signInSecurity.totp.title'), t('signInSecurity.totp.backupTitle')];

  const copyCodes = async (codes: string) => {
    try {
      await copyText(codes);
    } catch (reason) {
      toast.error(t('appInfo.toasts.copyFailed'));
      // Rethrown so the copy button keeps its copy glyph: nothing was copied.
      throw reason;
    }
    toast.success(t('signInSecurity.totp.copied'));
  };

  switch (step.name) {
    case 'codes':
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader title={t('signInSecurity.totp.backupTitle')} description={t('signInSecurity.totp.backupDescription')} />
          {step.enrolling ? <AccountFlowProgress steps={enrolSteps} current={1} testID="totp-progress" /> : null}
          {/* One code per line, with the block's own copy button (it shows a
              check once the codes are on the clipboard). */}
          <CodeBlock
            code={step.codes.join('\n')}
            filename={t('signInSecurity.totp.remaining', { count: step.codes.length })}
            lineNumbers={false}
            labels={{ copy: t('signInSecurity.totp.copy'), copied: t('signInSecurity.totp.copied') }}
            onCopy={copyCodes}
            testID="totp-backup-codes"
          />
          <AccountFlowAction
            label={t('signInSecurity.totp.savedThem')}
            onPress={() => {
              setStep({ name: 'status' });
              onDone?.();
            }}
            pending={false}
            testID="totp-codes-done"
          />
        </OxyAuthScreen>
      );
    case 'enroll': {
      const { enrollment } = step;
      return (
        <ReauthStep
          title={t('signInSecurity.totp.title')}
          description={t('signInSecurity.totp.scan')}
          action="totp"
          allowPassword={hasPassword}
          totpEnabled={false}
          submitLabel={t('signInSecurity.totp.enable')}
          validate={() => (new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(code.trim()) ? null : t('signin.errors.secondFactorInvalid'))}
          onSubmit={async (reauth) => {
            const codes = await oxyServices.auth.totp.confirm(code.trim(), reauth);
            refresh();
            toast.success(t('signInSecurity.totp.enabled'));
            setStep({ name: 'codes', codes, enrolling: true });
          }}
          secondary={back}
        >
          <AccountFlowProgress steps={enrolSteps} current={0} testID="totp-progress" />
          <View style={styles.plateRow}>
            <View style={[styles.plate, { borderColor: theme.colors.border }]} testID="totp-qr">
              <QRCode value={enrollment.otpauthUri} size={QR_SIZE} backgroundColor={QR_PLATE_BG} color={QR_FOREGROUND} />
            </View>
          </View>
          <View style={styles.secret}>
            <Text style={[styles.secretLabel, { color: theme.colors.textSecondary }]}>{t('signInSecurity.totp.secretLabel')}</Text>
            <Text selectable style={[styles.secretValue, { color: theme.colors.text }]} testID="totp-secret">
              {enrollment.secret.replace(/(.{4})/g, '$1 ').trim()}
            </Text>
          </View>
          <AccountFlowCodeField
            label={t('signInSecurity.totp.codeLabel')}
            value={code}
            onChange={setCode}
            error={null}
            length={TOTP_DIGITS}
            testID="totp-enroll-code"
          />
        </ReauthStep>
      );
    }
    case 'regenerate':
      return (
        <ReauthStep
          title={t('signInSecurity.totp.regenerate')}
          description={t('signInSecurity.totp.regenerateDescription')}
          action="totp"
          allowPassword={hasPassword}
          totpEnabled
          submitLabel={t('signInSecurity.totp.regenerate')}
          onSubmit={async (reauth) => {
            const codes = await oxyServices.auth.totp.regenerateBackupCodes(reauth);
            refresh();
            setStep({ name: 'codes', codes, enrolling: false });
          }}
          secondary={back}
        />
      );
    case 'disable':
      return (
        <ReauthStep
          title={t('signInSecurity.totp.disable')}
          description={t('signInSecurity.totp.description')}
          action="totp"
          allowPassword={hasPassword}
          totpEnabled
          submitLabel={t('signInSecurity.totp.disable')}
          destructive
          onSubmit={async (reauth) => {
            await oxyServices.auth.totp.disable(reauth);
            refresh();
            toast.success(t('signInSecurity.totp.disabled'));
            setStep({ name: 'status' });
            onDone?.();
          }}
          secondary={back}
        />
      );
    default:
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader
            title={t('signInSecurity.totp.title')}
            description={totpEnabled ? t('signInSecurity.totp.enabled') : t('signInSecurity.totp.description')}
          />
          {totpEnabled ? (
            <>
              <AccountFlowNote testID="totp-remaining">
                {t('signInSecurity.totp.remaining', { count: backupCodesRemaining })}
              </AccountFlowNote>
              <AccountFlowAction
                label={t('signInSecurity.totp.regenerate')}
                onPress={() => setStep({ name: 'regenerate' })}
                pending={false}
                testID="totp-regenerate"
              />
              <SubtleLink
                label={t('signInSecurity.totp.disable')}
                onPress={() => setStep({ name: 'disable' })}
                testID="totp-disable"
              />
            </>
          ) : (
            <>
              {error ? <AccountFlowErrorLine message={error} /> : null}
              <AccountFlowAction label={t('signInSecurity.totp.setUp')} onPress={setUp} pending={pending} testID="totp-set-up" />
            </>
          )}
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
  secret: {
    gap: 4,
    alignItems: 'center',
  },
  secretLabel: {
    fontSize: 14,
    lineHeight: 20,
  },
  secretValue: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    letterSpacing: 1,
    textAlign: 'center',
  },
});
