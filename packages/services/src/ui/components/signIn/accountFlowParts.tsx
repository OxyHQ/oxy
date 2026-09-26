/**
 * The pieces every Oxy sign-in and account screen shares: the error vocabulary,
 * one labelled field, the one primary action, a note, and the email-code step.
 * Each screen is built from the same shell as `OxySignInPanel`
 * (`OxyAuthScreen`), so they read as one product in the account dialog, in an
 * app's settings and on auth.oxy.so.
 */

import type React from 'react';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { useTheme } from '@oxy.so/bloom/theme';
import { TextField, TextFieldHint, TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import {
  EMAIL_CODE_LENGTH,
  EMAIL_SIGNIN_LONG_CODE_ALPHABET,
  EMAIL_SIGNIN_LONG_CODE_LENGTH,
  EMAIL_VERIFICATION_ERROR_CODES,
  SIGN_IN_ERROR_CODES,
  normalizeEmailSignInCode,
  type EmailVerificationConfirmResponse,
} from '@oxy.so/contracts';
import { useOxy } from '../../context/OxyContext';
import { useI18n } from '../../hooks/useI18n';
import type { Translate } from '../authChooser/types';
import { SubtleLink } from '../authChooser/primitives';
import { OxyAuthScreen, OxyAuthScreenHeader } from './OxyAuthScreen';

/** How long a screen waits after a 429 that names no wait of its own. */
export const RATE_LIMIT_SECONDS = 60;

/** The API error code a thrown SDK error carries (`error.code`), if any. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** An HTTP status off a thrown SDK error. */
function errorStatus(error: unknown): number | undefined {
  return (
    (error as { status?: number } | undefined)?.status ??
    (error as { response?: { status?: number } } | undefined)?.response?.status
  );
}

/** A 429: too many attempts or emails. */
export function isRateLimited(error: unknown): boolean {
  return errorStatus(error) === 429;
}

/** How long to wait after a 429, from the API's `retryAfterSeconds` when it sent one. */
export function retryAfterSeconds(error: unknown): number {
  const seconds = (error as { details?: { retryAfterSeconds?: unknown } } | undefined)?.details?.retryAfterSeconds;
  return typeof seconds === 'number' && seconds > 0 ? Math.ceil(seconds) : RATE_LIMIT_SECONDS;
}

/**
 * A failure of a sign-in or account screen, in the person's language. Never
 * says whether an account exists: every "no" is the same sentence.
 */
export function describeSignInError(error: unknown, t: Translate): string {
  switch (errorCode(error)) {
    case SIGN_IN_ERROR_CODES.invalidCredentials:
      return t('signin.errors.invalidCredentials');
    case SIGN_IN_ERROR_CODES.requestInvalid:
    case SIGN_IN_ERROR_CODES.linkInvalid:
      return t('signin.errors.requestExpired');
    case SIGN_IN_ERROR_CODES.secondFactorInvalid:
    case SIGN_IN_ERROR_CODES.totpCodeInvalid:
      return t('signin.errors.secondFactorInvalid');
    case SIGN_IN_ERROR_CODES.reauthInvalid:
    case SIGN_IN_ERROR_CODES.reauthRequired:
      return t('reauth.errors.invalid');
    case SIGN_IN_ERROR_CODES.totpRequired:
      return t('reauth.errors.totpRequired');
    case SIGN_IN_ERROR_CODES.originNotAllowed:
      return t('signin.errors.originNotAllowed');
    case SIGN_IN_ERROR_CODES.usernameTaken:
      return t('signup.username.taken');
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
      if (isRateLimited(error)) return t('signin.errors.rateLimited', { seconds: retryAfterSeconds(error) });
      return t('signin.errors.generic');
  }
}

/** Whether the confirmation this flow holds is gone and it must start again. */
export function isTicketExpired(error: unknown): boolean {
  const code = errorCode(error);
  return code === EMAIL_VERIFICATION_ERROR_CODES.ticketInvalid || code === EMAIL_VERIFICATION_ERROR_CODES.ticketRequired;
}

const SIX_DIGITS = new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`);
const LONG_CODE = new RegExp(`^[${EMAIL_SIGNIN_LONG_CODE_ALPHABET}]{${EMAIL_SIGNIN_LONG_CODE_LENGTH}}$`);

/**
 * Whether a typed sign-in code is complete: 6 digits, or the 10-character long
 * code (`XXXXX-XXXXX`, any case, with or without its dash). Six digits count
 * only when typed without a separator: the long code is shown with its dash
 * after the fifth character, so a long code being typed never reads as 6 digits.
 */
export function isCompleteSignInCode(typed: string): boolean {
  const trimmed = typed.trim();
  if (SIX_DIGITS.test(trimmed)) return true;
  return LONG_CODE.test(normalizeEmailSignInCode(trimmed));
}

/** A typed sign-in code as it shows in its field: upper-case, the long code's dash kept. */
export function formatSignInCodeInput(typed: string): string {
  return typed.toUpperCase().replace(/[^0-9A-Z-\s]/g, '').slice(0, EMAIL_SIGNIN_LONG_CODE_LENGTH + 1);
}

/** One labelled input, the way the sign-in screen draws its fields. */
export const AccountFlowField: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  error: string | null;
  disabled?: boolean;
  placeholder?: string;
  autoComplete?: 'username' | 'email' | 'one-time-code' | 'off' | 'current-password' | 'new-password';
  keyboardType?: 'default' | 'email-address' | 'number-pad';
  secureTextEntry?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  hint?: string;
  testID: string;
}> = ({
  label,
  value,
  onChange,
  onSubmit,
  error,
  disabled,
  placeholder,
  autoComplete,
  keyboardType,
  secureTextEntry,
  autoFocus = true,
  maxLength,
  hint,
  testID,
}) => (
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
        secureTextEntry={secureTextEntry}
        maxLength={maxLength}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        returnKeyType="go"
        onSubmitEditing={onSubmit}
        aria-required
      />
    </TextField>
    {error ? <TextFieldHint invalid>{error}</TextFieldHint> : hint ? <TextFieldHint>{hint}</TextFieldHint> : null}
  </View>
);

/** The screen's one primary action. */
export const AccountFlowAction: React.FC<{
  label: string;
  onPress: () => void;
  pending: boolean;
  disabled?: boolean;
  destructive?: boolean;
  testID: string;
}> = ({ label, onPress, pending, disabled, destructive, testID }) => (
  <Button
    appearance="solid"
    tone={destructive ? 'danger' : 'action'}
    size="lg"
    fullWidth
    loading={pending}
    disabled={pending || disabled}
    onPress={onPress}
    testID={testID}
  >
    {label}
  </Button>
);

/** A line of body copy under the header. */
export const AccountFlowNote: React.FC<{ children: React.ReactNode; testID?: string }> = ({ children, testID }) => {
  const theme = useTheme();
  return (
    <Text style={[styles.note, { color: theme.colors.textSecondary }]} testID={testID}>
      {children}
    </Text>
  );
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
  /** What was sent, and where. */
  description: string;
  verificationId: string;
  /** The code was right. A rejection is reported in place, like a wrong code. */
  onConfirmed: (confirmed: EmailVerificationConfirmResponse) => void | Promise<void>;
  /** Send a new code; resolves once it is on its way. */
  onResend: () => Promise<void>;
  /** "Use another email" / "Back" — the step before. */
  back: { label: string; onPress: () => void };
}

/** "Check your email": the 6-digit code an email verification sent. Submits itself once complete. */
export const EmailCodeStep: React.FC<EmailCodeStepProps> = ({ description, verificationId, onConfirmed, onResend, back }) => {
  const theme = useTheme();
  const { t } = useI18n();
  const { oxyServices } = useOxy();
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const confirm = (typed: string) => {
    if (pending) return;
    const digits = typed.replace(/\D/g, '');
    if (digits.length !== EMAIL_CODE_LENGTH) {
      setError(t('emailCode.errors.codeInvalid'));
      return;
    }
    setError(null);
    setPending(true);
    oxyServices
      .confirmEmailVerification(verificationId, digits)
      .then(onConfirmed)
      .catch((reason: unknown) => setError(describeSignInError(reason, t)))
      .finally(() => setPending(false));
  };

  const resend = () => {
    setError(null);
    setNotice(null);
    setCode('');
    onResend()
      .then(() => setNotice(t('emailCode.resent')))
      .catch((reason: unknown) => setError(describeSignInError(reason, t)));
  };

  return (
    <OxyAuthScreen>
      <OxyAuthScreenHeader title={t('emailCode.title')} description={description} />
      <AccountFlowField
        label={t('emailCode.label')}
        value={code}
        onChange={(value) => {
          const digits = value.replace(/\D/g, '').slice(0, EMAIL_CODE_LENGTH);
          setCode(digits);
          if (error) setError(null);
          if (digits.length === EMAIL_CODE_LENGTH) confirm(digits);
        }}
        onSubmit={() => confirm(code)}
        error={error}
        disabled={pending}
        placeholder="000000"
        autoComplete="one-time-code"
        keyboardType="number-pad"
        maxLength={EMAIL_CODE_LENGTH}
        testID="email-code"
      />
      {notice ? <Text style={[styles.note, { color: theme.colors.textSecondary }]}>{notice}</Text> : null}
      <AccountFlowAction label={t('signin.actions.continue')} onPress={() => confirm(code)} pending={pending} testID="email-code-continue" />
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
