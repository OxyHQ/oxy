/**
 * What a Console edit to an application's webhook endpoints actually sends
 * (issue #972, "webhooks/audit events where applicable").
 *
 * Split out of the section component for the reason `lib/credential-audit.ts`
 * and `lib/account-audit.ts` were: this is the decision that can be silently
 * WRONG on a form that still looks right, and it is testable without rendering
 * anything.
 *
 * ## An empty string is a VALUE here, and collapsing it loses a whole operation
 *
 * `PATCH /applications/:appId` writes `body.webhookUrl || null` — so `''` CLEARS
 * the stored endpoint, and clearing it is the only way to stop delivery. The
 * usual `value.trim() || undefined` idiom, which is right for a name or a
 * description, turns "stop delivering to my production receiver" into "leave it
 * alone" and reports success. So the patch below distinguishes three states, not
 * two: absent (do not touch), `''` (clear), a URL (set).
 *
 * ## Trimming has to happen ONCE, before the comparison, not after it
 *
 * The server rotates this application's signing secret whenever the production
 * URL it receives DIFFERS from the stored one (`routes/applications.ts`, the
 * `body.webhookUrl !== stored.webhookUrl` branch). A form that decided dirtiness
 * on the raw input and then sent a trimmed value — or the reverse — would
 * disagree with itself: a trailing space typed into an unchanged URL would ship
 * a "change" and silently replace a secret nobody can read back, breaking every
 * signature the customer's receiver checks. One function therefore produces both
 * the answer to "is this dirty" and the bytes that are sent, from the same
 * trimmed values.
 *
 * ## The permission is part of the payload decision
 *
 * `webhooks:update` answers to `apps:update` by containment
 * (`api/src/utils/accountRoles.ts`), so a caller without it cannot write these
 * fields — the server would drop them, or accept them from a different right
 * than the one the form showed. A caller who may not edit sends nothing at all,
 * which is why `canEdit` is an argument here rather than a `disabled` prop the
 * payload never sees.
 */

/** The two endpoints as the form holds them: strings, never null or undefined. */
export interface WebhookEndpointDraft {
  /** Where production events would be delivered. `''` means none. */
  readonly webhookUrl: string;
  /** Where development and staging events would be delivered. `''` means none. */
  readonly devWebhookUrl: string;
}

/**
 * The webhook fields of a `PATCH /applications/:appId` body.
 *
 * Both optional, and the distinction is load-bearing: an ABSENT key leaves the
 * column alone, `''` clears it. Never widened to `string | null` — the route
 * accepts `''`, not `null`, for `webhookUrl`.
 */
export interface WebhookPatch {
  readonly webhookUrl?: string;
  readonly devWebhookUrl?: string;
}

/**
 * The stored endpoints as a draft: the application's own values, with an unset
 * column read as the empty string the input needs.
 */
export function storedWebhookEndpoints(application: {
  readonly webhookUrl?: string;
  readonly devWebhookUrl?: string;
}): WebhookEndpointDraft {
  return {
    webhookUrl: application.webhookUrl ?? '',
    devWebhookUrl: application.devWebhookUrl ?? '',
  };
}

/**
 * The fields to send, given what is stored and what the form holds.
 *
 * Only fields that actually CHANGED, and only when the caller may write them.
 * Sending an unchanged production URL would be harmless today — the route
 * compares before rotating — but it makes the request say something the user did
 * not do, and the rotation branch is one comparison away from that being false.
 *
 * An empty object means there is nothing to save, which is also what disables
 * the button; {@link hasWebhookChanges} reads this rather than repeating the
 * comparison.
 */
export function webhookPatch(
  stored: WebhookEndpointDraft,
  draft: WebhookEndpointDraft,
  canEdit: boolean
): WebhookPatch {
  if (!canEdit) {
    return {};
  }
  const patch: { webhookUrl?: string; devWebhookUrl?: string } = {};
  const webhookUrl = draft.webhookUrl.trim();
  const devWebhookUrl = draft.devWebhookUrl.trim();
  if (webhookUrl !== stored.webhookUrl) {
    patch.webhookUrl = webhookUrl;
  }
  if (devWebhookUrl !== stored.devWebhookUrl) {
    patch.devWebhookUrl = devWebhookUrl;
  }
  return patch;
}

/** Whether saving would send anything at all. */
export function hasWebhookChanges(patch: WebhookPatch): boolean {
  return patch.webhookUrl !== undefined || patch.devWebhookUrl !== undefined;
}

/**
 * Whether saving this patch would replace the application's signing secret.
 *
 * True for ANY change to the production URL, including clearing it: the server
 * regenerates the secret on every difference and sets it to null when the URL is
 * emptied. The development URL never rotates anything.
 *
 * Read from the patch rather than recomputed from the drafts, so the warning the
 * form shows and the request it sends can never disagree about what changed.
 */
export function rotatesSigningSecret(patch: WebhookPatch): boolean {
  return patch.webhookUrl !== undefined;
}
