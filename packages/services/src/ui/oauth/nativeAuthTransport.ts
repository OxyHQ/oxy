import type { OxyServices } from '@oxy.so/core';
import { openAuthorizeUrlNative } from '../components/oauthNavigation';
import { resolveApplicationSessionLane } from './applicationSessionLane';
import { completeOAuthCode } from './completeOAuthCode';
import { prepareAuthorizeRequest } from './oauthHandshake';
import type { OAuthSessionCommitInput } from './types';

export interface StartNativeOAuthSignInOptions {
  /** Exact registered URI, including any fixed query. Never inferred. */
  redirectUri: string;
}
export type NativeOAuthSignInResult =
  | { status: 'signed-in' }
  | { status: 'cancelled' }
  | { status: 'unsupported'; reason: 'unsupported-platform' | 'missing-client-id' | 'identity-bound' | 'not-third-party' }
  | { status: 'failed'; reason: 'invalid-redirect-uri' | 'client-resolution-failed' | 'native-callback-invalid' | 'state-mismatch' | 'exchange-failed' | 'already-in-progress' };
export interface NativeOAuthSignInContext {
  platform: 'native' | 'unsupported';
  oxyServices: OxyServices;
  clientId: string | null;
  authorizeBaseUrl?: string;
  identityBound: boolean;
  commitSession: (input: OAuthSessionCommitInput) => Promise<void>;
}
const attempts = new WeakSet<OxyServices>();

function isExactRedirectUri(value: string): boolean {
  if (!value || value !== value.trim() || /\s/.test(value)) return false;
  try {
    const uri = new URL(value);
    return !uri.username && !uri.password && !uri.hash &&
      !['code', 'state', 'error', 'error_description'].some((key) => uri.searchParams.has(key));
  } catch { return false; }
}

/** SDK owns the in-memory handshake, observed native callback and session commit. */
export async function startNativeOAuthSignIn(
  context: NativeOAuthSignInContext,
  options: StartNativeOAuthSignInOptions,
): Promise<NativeOAuthSignInResult> {
  if (context.platform !== 'native') return { status: 'unsupported', reason: 'unsupported-platform' };
  if (!context.clientId) return { status: 'unsupported', reason: 'missing-client-id' };
  if (context.identityBound) return { status: 'unsupported', reason: 'identity-bound' };
  if (!isExactRedirectUri(options.redirectUri)) return { status: 'failed', reason: 'invalid-redirect-uri' };
  if (attempts.has(context.oxyServices)) return { status: 'failed', reason: 'already-in-progress' };
  attempts.add(context.oxyServices);
  try {
    let lane: 'device' | 'oauth';
    try { lane = await resolveApplicationSessionLane(context.oxyServices, context.clientId); }
    catch { return { status: 'failed', reason: 'client-resolution-failed' }; }
    if (lane !== 'oauth') return { status: 'unsupported', reason: 'not-third-party' };
    const prepared = await prepareAuthorizeRequest({ clientId: context.clientId, redirectUri: options.redirectUri, authorizeBaseUrl: context.authorizeBaseUrl });
    const { redirectUrl } = await openAuthorizeUrlNative(prepared.authorizeUrl, options.redirectUri, { allowExternalFallback: false });
    if (!redirectUrl) return { status: 'cancelled' };
    const prefix = `${options.redirectUri}${options.redirectUri.includes('?') ? '&' : '?'}`;
    if (!redirectUrl.startsWith(prefix) || redirectUrl.includes('#')) return { status: 'failed', reason: 'native-callback-invalid' };
    const parameters = new URLSearchParams(redirectUrl.slice(prefix.length));
    if ([...new URL(options.redirectUri).searchParams.keys()].some((key) => parameters.has(key))) return { status: 'failed', reason: 'native-callback-invalid' };
    if (['code', 'state', 'error', 'error_description'].some((key) => parameters.getAll(key).length > 1)) return { status: 'failed', reason: 'native-callback-invalid' };
    if (parameters.get('state') !== prepared.handshake.state) return { status: 'failed', reason: 'state-mismatch' };
    if (parameters.has('error') || !parameters.get('code')) return { status: 'failed', reason: 'native-callback-invalid' };
    const completion = await completeOAuthCode({ oxyServices: context.oxyServices, clientId: context.clientId, code: parameters.get('code')!, returnedState: parameters.get('state'), handshake: prepared.handshake, redirectUri: options.redirectUri, commitSession: context.commitSession });
    return completion.ok ? { status: 'signed-in' } : { status: 'failed', reason: completion.reason };
  } catch { return { status: 'failed', reason: 'exchange-failed' }; }
  finally { attempts.delete(context.oxyServices); }
}
