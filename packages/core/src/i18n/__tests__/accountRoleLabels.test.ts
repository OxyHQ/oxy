import type { AccountRole } from '../../mixins/OxyServices.accounts';
import { EN_ACCOUNT_ROLE_LABELS, accountRoleLabel } from '../accountRoleLabels';

const ACCOUNT_ROLES: AccountRole[] = [
  'owner',
  'admin',
  'editor',
  'developer',
  'billing',
  'viewer',
];

const SHIPPED_LOCALES = [
  'en-US',
  'es-ES',
  'ca-ES',
  'fr-FR',
  'de-DE',
  'it-IT',
  'pt-PT',
  'ja-JP',
  'ko-KR',
  'zh-CN',
  'ar-SA',
] as const;
const REGION_VARIANT = 'es-MX';
const UNSHIPPED_LOCALE = 'nl-NL';

describe('accountRoleLabel', () => {
  it('covers the whole vocabulary', () => {
    expect(ACCOUNT_ROLES.length).toBe(6);
    expect(Object.keys(EN_ACCOUNT_ROLE_LABELS)).toHaveLength(ACCOUNT_ROLES.length);
  });

  it.each([...SHIPPED_LOCALES, REGION_VARIANT, UNSHIPPED_LOCALE])(
    'names every role in %s — never a key, never a slug, never empty',
    (locale) => {
      for (const role of ACCOUNT_ROLES) {
        const label = accountRoleLabel(locale, role);
        expect(label).not.toBe('');
        expect(label).not.toBe(`accounts.roles.${role}.label`);
      }
    },
  );

  it('falls back to English for a language with no role translations', () => {
    expect(accountRoleLabel('de-DE', 'developer')).toBe(EN_ACCOUNT_ROLE_LABELS.developer);
  });

  it('resolves a region variant through its base language', () => {
    expect(accountRoleLabel('es-MX', 'admin')).toBe(accountRoleLabel('es-ES', 'admin'));
    expect(accountRoleLabel('es-MX', 'admin')).not.toBe(EN_ACCOUNT_ROLE_LABELS.admin);
  });
});
