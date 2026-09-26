/**
 * `oxy.linkedAccounts` — external accounts (any Mastodon-API server, Bluesky)
 * the current user has PROVEN they own by completing an OAuth authorization
 * there. Oxy uses that authorization only to learn which account granted it and
 * then discards the token — nothing here ever carries a third-party token.
 *
 * The flow is a top-level browser navigation: `start` returns the other
 * network's `authorizeUrl`; open it (a new tab, or `expo-web-browser`'s auth
 * session on native); the network sends the browser to Oxy's callback, and Oxy
 * sends it to `returnTo` with `?link_code=<code>` or `?link_error=<code>`. Pass
 * the code to `complete` with the same user signed in: that call, not the
 * callback, creates the link, so an authorization someone else started can
 * never link to them. `returnTo` must be a redirect URI registered on the
 * first-party application `clientId` names.
 *
 * Wire types live in `@oxy.so/contracts` (`linkedAccounts.ts`).
 */
import type {
  CompleteLinkedAccountResponse,
  LinkedAccount,
  LinkedAccountListResponse,
  LinkedAccountNetwork,
  StartLinkedAccountRequest,
  StartLinkedAccountResponse,
} from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';

export class LinkedAccountsApi {
  constructor(protected readonly ctx: OxyContext) {}

  /**
   * Begin linking an external account for the current user.
   *
   * @param network - `'activitypub'` (any Mastodon-API server) or `'atproto'` (Bluesky).
   * @param options - `instance` for ActivityPub (`mastodon.social`, or
   *   `@user@mastodon.social`), `handle` for atproto; `clientId` + `returnTo`
   *   to be sent back to your app afterwards.
   * @returns The URL to open, and when the attempt expires (ten minutes).
   */
  async start(network: LinkedAccountNetwork, options: StartLinkedAccountRequest): Promise<StartLinkedAccountResponse> {
    return this.ctx.request<StartLinkedAccountResponse>(
      'POST',
      `/linked-accounts/${encodeURIComponent(network)}/start`,
      options,
      { cache: false },
    );
  }

  /**
   * Finish a link with the `link_code` the callback appended to `returnTo`.
   * Must be the user who started the flow: for anyone else the API answers 403
   * and burns the code. 409 when the account is already someone else's link.
   * Repeating it within the code's five minutes returns the same link.
   */
  async complete(code: string): Promise<LinkedAccount> {
    const res = await this.ctx.request<CompleteLinkedAccountResponse>('POST', '/linked-accounts/complete', { code }, {
      cache: false,
    });
    return res.linkedAccount;
  }

  /** The current user's live linked accounts, oldest first. */
  async list(): Promise<LinkedAccount[]> {
    const res = await this.ctx.request<LinkedAccountListResponse>('GET', '/linked-accounts', undefined, { cache: false });
    return res.linkedAccounts;
  }

  /**
   * Unlink one of the current user's accounts. An ActivityPub link stops being
   * published as an `alsoKnownAs` alias, and the external account can then be
   * linked to another Oxy account.
   */
  async revoke(linkedAccountId: string): Promise<void> {
    await this.ctx.request<void>('DELETE', `/linked-accounts/${encodeURIComponent(linkedAccountId)}`, undefined, {
      cache: false,
    });
  }
}
