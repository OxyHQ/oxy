/**
 * The pieces auth.oxy.so's account pages share (ADR 0029 D3): creating a
 * passkey account, recovering one, deleting one. Each is a page of the IdP
 * built from the same sign-in shell as `OxySignInPanel`, so they read as one
 * product; the passkey belongs to auth.oxy.so, so none of them runs anywhere
 * else.
 */

import type React from 'react';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { useTheme } from '@oxy.so/bloom/theme';
import { TextField, TextFieldHint, TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import { EMAIL_CODE_LENGTH, EMAIL_VERIFICATION_ERROR_CODES, type EmailVerificationConfirmResponse } from '@oxy.so/contracts';
import { useOxy } from '../../context/OxyContext';
import { useI18n } from '../../hooks/useI18n';
import type { Translate } from '../authChooser/types';
import { SubtleLink } from '../authChooser/primitives';
import { OxyAuthScreen, OxyAuthScreenHeader } from './OxyAuthScreen';
import { describePasskeyError, isRateLimited } from './passkeyError';

/** The API error code a thrown SDK error carries (`error.code`), if any. */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** A failure of an account page, in the person's language. */
export function describeAccountFlowError(error: unknown, t: Translate): string {
  switch (errorCode(error)) {
    case EMAIL_VERIFICATION_ERROR_CODES.codeInvalid:
      return t('emailCode.errors.codeInvalid');
    case EMAIL_VERIFICATION_ERROR_CODES.tooManyAttempts:
      return t('emailCode.errors.tooManyAttempts');
    case EMAIL_VERIFICATION_ERROR_CODES.ticketInvalid:
    case EMAIL_VERIFICATION_ERROR_CODES.ticketRequired:
      return t('emailCode.errors.expired');
    case EMAIL_VERIFICATION_ERROR_CODES.unavailable:
      return t('emailCode.errors.unavailable');
    default:
      if (isRateLimited(error)) return t('emailCode.errors.rateLimited');
      return describePasskeyError(error, t);
  }
}

/** Whether the confirmation this flow holds is gone and it must start again. */
export function isTicketExpired(error: unknown): boolean {
  const code = errorCode(error);
  return code === EMAIL_VERIFICATION_ERROR_CODES.ticketInvalid || code === EMAIL_VERIFICATION_ERROR_CODES.ticketRequired;
}

/** One labelled input, the way the sign-in screen draws its username. */
export const AccountFlowField: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  error: string | null;
  disabled?: boolean;
  placeholder?: string;
  autoComplete?: 'username' | 'email' | 'one-time-code' | 'off';
  keyboardType?: 'default' | 'email-address' | 'number-pad';
  maxLength?: number;
  testID: string;
}> = ({ label, value, onChange, onSubmit, error, disabled, placeholder, autoComplete, keyboardType, maxLength, testID }) => (
  <View style={styles.field}>
    <TextFieldLabel>{label}</TextFieldLabel>
    <TextField invalid={error !== null} disabled={disabled} radius={999} style={styles.input}>
      <TextFieldInput
        testID={testID}
        label={label}
        value={value}
        onValueChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        keyboardType={keyboardType}
        maxLength={maxLength}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        returnKeyType="go"
        onSubmitEditing={onSubmit}
        aria-required
      />
    </TextField>
    {error ? <TextFieldHint invalid>{error}</TextFieldHint> : null}
  </View>
);

/** The screen's one primary action. */
export const AccountFlowAction: React.FC<{
  label: string;
  onPress: () => void;
  pending: boolean;
  disabled?: boolean;
  testID: string;
}> = ({ label, onPress, pending, disabled, testID }) => (
  <Button appearance="solid" tone="action" size="lg" fullWidth loading={pending} disabled={pending || disabled} onPress={onPress} testID={testID}>
    {label}
  </Button>
);

/** A line of body copy under the header. */
export const AccountFlowNote: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const theme = useTheme();
  return <Text style={[styles.note, { color: theme.colors.textSecondary }]}>{children}</Text>;
};

/** Why a step failed, where it happened. */
export const AccountFlowErrorLine: React.FC<{ message: string }> = ({ message }) => {
  const theme = useTheme();
  return (
    <Text accessibilityRole="alert" style={[styles.note, { color: theme.colors.error }]}>
      {message}
    </Text>
  );
};

export interface EmailCodeStepProps {
  /** What was sent, and where (or, for a recovery, where it may have gone). */
  description: string;
  verificationId: string;
  onConfirmed: (confirmed: EmailVerificationConfirmResponse) => void;
  /** Send a new code; resolves once it is on its way. */
  onResend: () => Promise<void>;
  /** "Use another email" / "Back" — the step before. */
  back: { label: string; onPress: () => void };
}

/** "Check your email": the 6-digit code a verification sent. */
export const EmailCodeStep: React.FC<EmailCodeStepProps> = ({ description, verificationId, onConfirmed, onResend, back }) => {
  const theme = useTheme();
  const { t } = useI18n();
  const { oxyServices } = useOxy();
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const confirm = () => {
    const digits = code.replace(/\D/g, '');
    if (digits.length !== EMAIL_CODE_LENGTH || pending) {
      setError(t('emailCode.errors.codeInvalid'));
      return;
    }
    setError(null);
    setPending(true);
    oxyServices
      .confirmEmailVerification(verificationId, digits)
      .then(onConfirmed)
      .catch((reason: unknown) => setError(describeAccountFlowError(reason, t)))
      .finally(() => setPending(false));
  };

  const resend = () => {
    setError(null);
    setNotice(null);
    setCode('');
    onResend()
      .then(() => setNotice(t('emailCode.resent')))
      .catch((reason: unknown) => setError(describeAccountFlowError(reason, t)));
  };

  return (
    <OxyAuthScreen>
      <OxyAuthScreenHeader title={t('emailCode.title')} description={description} />
      <AccountFlowField
        label={t('emailCode.label')}
        value={code}
        onChange={(value) => {
          setCode(value);
          if (error) setError(null);
        }}
        onSubmit={confirm}
        error={error}
        disabled={pending}
        placeholder="000000"
        autoComplete="one-time-code"
        keyboardType="number-pad"
        maxLength={EMAIL_CODE_LENGTH}
        testID="email-code"
      />
      {notice ? <Text style={[styles.note, { color: theme.colors.textSecondary }]}>{notice}</Text> : null}
      <AccountFlowAction label={t('signin.actions.continue')} onPress={confirm} pending={pending} testID="email-code-continue" />
      <SubtleLink label={t('emailCode.resend')} theme={theme} onPress={resend} disabled={pending} testID="email-code-resend" />
      <SubtleLink label={back.label} theme={theme} onPress={back.onPress} disabled={pending} testID="email-code-back" />
    </OxyAuthScreen>
  );
};

const styles = StyleSheet.create({
  field: {
    gap: 6,
  },
  input: {
    height: 40,
  },
  note: {
    fontSize: 16,
    lineHeight: 24,
  },
});
