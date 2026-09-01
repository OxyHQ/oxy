import type { AccountRole } from '../mixins/OxyServices.accounts';
import enUS from './locales/en-US.json';
import { translate } from './index';

/**
 * Every account member role's English name, keyed by its stable id.
 *
 * Totality is over the closed `AccountRole` union so a new role without an
 * English label is a build error, not a members row that paints
 * `accounts.roles.<role>.label`.
 */
export const EN_ACCOUNT_ROLE_LABELS: Record<AccountRole, string> = {
  owner: enUS.accounts.roles.owner.label,
  admin: enUS.accounts.roles.admin.label,
  editor: enUS.accounts.roles.editor.label,
  developer: enUS.accounts.roles.developer.label,
  billing: enUS.accounts.roles.billing.label,
  viewer: enUS.accounts.roles.viewer.label,
};

export function accountRoleLabel(
  locale: string | undefined,
  role: AccountRole,
): string {
  return translate(locale, `accounts.roles.${role}.label`);
}
