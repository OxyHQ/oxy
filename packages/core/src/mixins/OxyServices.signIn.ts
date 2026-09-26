/**
 * Signing in without a passkey, and how an account signs in.
 *
 * - Email: {@link startEmailSignIn} sends one email with a 6-digit code and a
 *   one-use link. The dialog keeps the returned `requestSecret` IN MEMORY and
 *   either confirms the code ({@link confirmEmailSignIn}) or polls
 *   {@link collectEmailSignIn} until the link is opened in this same browser.
 *   auth.oxy.so's link page calls {@link approveEmailSignInLink}.
 * - Password: {@link signInWithPassword}.
 * - Authenticator: when the account has one, every first factor answers
 *   `{ secondFactorRequired, challengeId }` instead of a session, and
 *   {@link completeSecondFactor} takes its code (or a backup code).
 * - Sign-up: {@link signUp} with the ticket `confirmEmailVerification` returned
 *   for a `signup` code.
 *
 * Every call that can end in a session attaches THIS client's device proof
 * ({@link OxyServicesBase.readDeviceProof}, ADR 0029 D2) unless the caller
 * passes `device` itself (`null` opts out), so the account lands on the
 * browser's shared device; a session result plants its access token.
 *
 * The signed-in half — {@link getSignInMethods}, {@link requestReauthEmailCode},
 * {@link setPassword}, the TOTP methods — carries a `reauth` proof in the
 * request it authorises: the current password or a code just sent to the
 * account's email, plus the authenticator's code once it is on.
 */
import {
  emailSignInLinkResponseSchema,
  emailSignInPendingSchema,
  emailSignInStartResponseSchema,
  emailVerificationStartResponseSchema,
  loginResultSchema,
  safeParseContract,
  secondFactorRequiredSchema,
  signInMethodsSchema,
  totpBackupCodesResponseSchema,
  totpEnrollResponseSchema,
  type DeviceProof,
  type EmailSignInPending,
  type EmailSignInStartResponse,
  type EmailVerificationStartResponse,
  type LoginResult,
  type ReauthAction,
  type ReauthProof,
  type SignInMethods,
  type SignInStepResult,
  type TotpEnrollResponse,
} from '@oxy.so/contracts';
import type { OxyServicesBase } from '../OxyServices.base';

/** The device-session fields a sign-in may carry. */
export interface SignInDeviceOptions {
  deviceName?: string;
  deviceFingerprint?: string;
  /** The device the session joins; defaults to the one this client holds. `null` opts out. */
  device?: DeviceProof | null;
}

export function OxyServicesSignInMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    /** The body fields a session-ending call sends: the options, plus the device proof. */
    async _signInEnvelope(options: SignInDeviceOptions = {}): Promise<Record<string, unknown>> {
      const { device: explicit, deviceName, deviceFingerprint } = options;
      const device = explicit === undefined ? await this.readDeviceProof() : explicit;
      return {
        ...(deviceName ? { deviceName } : {}),
        ...(deviceFingerprint ? { deviceFingerprint } : {}),
        ...(device ? { device } : {}),
      };
    }

    /** Parse a session, planting its token. */
    _plantSession(res: unknown, path: string): LoginResult {
      const parsed = safeParseContract(loginResultSchema, res);
      if (!parsed) throw new Error(`${path} returned an unexpected response shape`);
      if (parsed.accessToken) this.setTokens(parsed.accessToken);
      return parsed;
    }

    /** Parse a first factor's answer: the second-factor step, or a session. */
    _signInStep(res: unknown, path: string): SignInStepResult {
      const challenge = safeParseContract(secondFactorRequiredSchema, res);
      if (challenge) return challenge;
      return this._plantSession(res, path);
    }

    /**
     * Send the sign-in email (a code and a link) for a username or email. The
     * answer is the same whether or not the account exists. Keep
     * `requestSecret` in memory only.
     */
    async startEmailSignIn(identifier: string, options: { device?: DeviceProof | null } = {}): Promise<EmailSignInStartResponse> {
      try {
        const device = options.device === undefined ? await this.readDeviceProof() : options.device;
        const res = await this.makeRequest<unknown>(
          'POST',
          '/auth/signin/email/start',
          { identifier, ...(device ? { device } : {}) },
          { cache: false, skipAuth: true },
        );
        const parsed = safeParseContract(emailSignInStartResponseSchema, res);
        if (!parsed) throw new Error('auth/signin/email/start returned an unexpected response shape');
        return parsed;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * The code from the email → a session, or the second-factor step. The code
     * is 6 digits, or the 10-character long code (`XXXXX-XXXXX`) an account
     * gets after too many guesses in a day — accept both in one field and pass
     * it as typed.
     */
    async confirmEmailSignIn(
      request: { requestId: string; requestSecret: string; code: string } & SignInDeviceOptions,
    ): Promise<SignInStepResult> {
      try {
        const { requestId, requestSecret, code, ...options } = request;
        const res = await this.makeRequest<unknown>(
          'POST',
          '/auth/signin/email/confirm',
          { requestId, requestSecret, code, ...(await this._signInEnvelope(options)) },
          { cache: false, skipAuth: true },
        );
        return this._signInStep(res, 'auth/signin/email/confirm');
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Whether the email's link was opened in this browser: `{ status: 'pending' }`
     * until it was, then a session (or the second-factor step). Poll it.
     */
    async collectEmailSignIn(
      request: { requestId: string; requestSecret: string } & SignInDeviceOptions,
    ): Promise<SignInStepResult | EmailSignInPending> {
      try {
        const { requestId, requestSecret, ...options } = request;
        const res = await this.makeRequest<unknown>(
          'POST',
          '/auth/signin/email/collect',
          { requestId, requestSecret, ...(await this._signInEnvelope(options)) },
          { cache: false, skipAuth: true },
        );
        const pending = safeParseContract(emailSignInPendingSchema, res);
        if (pending) return pending;
        return this._signInStep(res, 'auth/signin/email/collect');
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * auth.oxy.so's link page: approve the request with THIS client's device
     * proof. It approves only in the browser that asked, and never returns a
     * session here — the app's dialog collects it.
     */
    async approveEmailSignInLink(token: string, device?: DeviceProof): Promise<{ approved: true }> {
      try {
        const proof = device ?? (await this.readDeviceProof());
        if (!proof) throw new Error('This browser holds no Oxy device to approve the sign-in with');
        const res = await this.makeRequest<unknown>(
          'POST',
          '/auth/signin/email/link',
          { token, device: proof },
          { cache: false, skipAuth: true },
        );
        const parsed = safeParseContract(emailSignInLinkResponseSchema, res);
        if (!parsed) throw new Error('auth/signin/email/link returned an unexpected response shape');
        return parsed;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** A username or email and its password → a session, or the second-factor step. */
    async signInWithPassword(request: { identifier: string; password: string } & SignInDeviceOptions): Promise<SignInStepResult> {
      try {
        const { identifier, password, ...options } = request;
        const res = await this.makeRequest<unknown>(
          'POST',
          '/auth/signin/password',
          { identifier, password, ...(await this._signInEnvelope(options)) },
          { cache: false, skipAuth: true },
        );
        return this._signInStep(res, 'auth/signin/password');
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * The authenticator's code (or a backup code) for a first factor's
     * challenge → the session. Send the same device proof the first factor did
     * (the default does).
     */
    async completeSecondFactor(request: { challengeId: string; code: string } & SignInDeviceOptions): Promise<LoginResult> {
      try {
        const { challengeId, code, ...options } = request;
        const res = await this.makeRequest<unknown>(
          'POST',
          '/auth/signin/second-factor',
          { challengeId, code, ...(await this._signInEnvelope(options)) },
          { cache: false, skipAuth: true },
        );
        return this._plantSession(res, 'auth/signin/second-factor');
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** Create an account from a username and a confirmed email, and sign in. */
    async signUp(request: { username: string; email: string; emailTicket: string } & SignInDeviceOptions): Promise<LoginResult> {
      try {
        const { username, email, emailTicket, ...options } = request;
        const res = await this.makeRequest<unknown>(
          'POST',
          '/auth/signup',
          { username, email, emailTicket, ...(await this._signInEnvelope(options)) },
          { cache: false, skipAuth: true },
        );
        return this._plantSession(res, 'auth/signup');
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** How the signed-in account signs in. */
    async getSignInMethods(): Promise<SignInMethods> {
      try {
        const res = await this.makeRequest<unknown>('GET', '/users/me/sign-in-methods', undefined, { cache: false });
        const parsed = safeParseContract(signInMethodsSchema, res);
        if (!parsed) throw new Error('users/me/sign-in-methods returned an unexpected response shape');
        return parsed;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Send a confirmation code to the signed-in account's email, for a
     * `reauth: { emailCode: { verificationId, code } }` proof of ONE change:
     * the code works only for the `action` it was asked for, and the email
     * names it.
     */
    async requestReauthEmailCode(action: ReauthAction): Promise<EmailVerificationStartResponse> {
      try {
        const res = await this.makeRequest<unknown>('POST', '/users/me/reauth/email', { action }, { cache: false });
        const parsed = safeParseContract(emailVerificationStartResponseSchema, res);
        if (!parsed) throw new Error('users/me/reauth/email returned an unexpected response shape');
        return parsed;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** Set or change the password. `revokeOtherSessions` signs every other session out. */
    async setPassword(request: { newPassword: string; reauth: ReauthProof; revokeOtherSessions?: boolean }): Promise<{ success: true }> {
      try {
        return await this.makeRequest<{ success: true }>('PUT', '/users/me/password', request, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** Start setting up an authenticator: its secret and `otpauth://` URI (for the QR). Off until confirmed. */
    async enrollTotp(): Promise<TotpEnrollResponse> {
      try {
        const res = await this.makeRequest<unknown>('POST', '/users/me/totp/enroll', undefined, { cache: false });
        const parsed = safeParseContract(totpEnrollResponseSchema, res);
        if (!parsed) throw new Error('users/me/totp/enroll returned an unexpected response shape');
        return parsed;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** Turn the authenticator on with its first code. Resolves to the backup codes, shown once. */
    async confirmTotp(code: string, reauth: ReauthProof): Promise<string[]> {
      try {
        const res = await this.makeRequest<unknown>('POST', '/users/me/totp/confirm', { code, reauth }, { cache: false });
        const parsed = safeParseContract(totpBackupCodesResponseSchema, res);
        if (!parsed) throw new Error('users/me/totp/confirm returned an unexpected response shape');
        return parsed.backupCodes;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** Turn the authenticator off. */
    async disableTotp(reauth: ReauthProof): Promise<{ success: true }> {
      try {
        return await this.makeRequest<{ success: true }>('POST', '/users/me/totp/disable', { reauth }, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** A new set of backup codes; the old ones stop working. */
    async regenerateTotpBackupCodes(reauth: ReauthProof): Promise<string[]> {
      try {
        const res = await this.makeRequest<unknown>('POST', '/users/me/totp/backup-codes', { reauth }, { cache: false });
        const parsed = safeParseContract(totpBackupCodesResponseSchema, res);
        if (!parsed) throw new Error('users/me/totp/backup-codes returned an unexpected response shape');
        return parsed.backupCodes;
      } catch (error) {
        throw this.handleError(error);
      }
    }
  };
}
