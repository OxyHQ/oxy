import { loadLocale, translate } from '@oxy.so/core';
import { checkUsernameDraft } from '../../src/ui/utils/usernamePolicy';

const en = (key: string, vars?: Record<string, string | number>) => translate('en-US', key, vars);
const es = (key: string, vars?: Record<string, string | number>) => translate('es-ES', key, vars);

const reason = (value: string, kind?: 'personal' | 'bot') => {
  const result = checkUsernameDraft(value, en, kind);
  return result.ok ? null : result.error;
};

describe('checkUsernameDraft', () => {
  it('accepts a valid handle, trimmed and with its case kept', () => {
    expect(checkUsernameDraft('  Ada_Lovelace ', en)).toEqual({
      ok: true,
      username: 'Ada_Lovelace',
    });
  });

  it('names the rule each refused handle broke', () => {
    expect(reason('')).toBe('Choose a username.');
    expect(reason('   ')).toBe('Choose a username.');
    expect(reason('ab')).toBe('Use at least 3 characters.');
    expect(reason('a'.repeat(31))).toBe('Use at most 30 characters.');
    expect(reason('hash saah')).toBe("Usernames can't contain spaces. Use - or _ instead.");
    expect(reason('a--b')).toMatch(/^Use only letters, numbers, - and _/);
    expect(reason('-ada')).toMatch(/^Use only letters, numbers, - and _/);
    expect(reason('ada.l')).toMatch(/^Use only letters, numbers, - and _/);
    expect(reason('12345')).toBe("A username can't be only numbers. Add a letter.");
    expect(reason('Admin')).toBe('That username is reserved. Choose another one.');
    expect(reason('super-admin')).toBe('That username is reserved. Choose another one.');
  });

  it('holds a bot handle to the bot policy', () => {
    expect(reason('garden', 'bot')).toBe('A bot account’s username must end in “bot”.');
    expect(checkUsernameDraft('gardenbot', en, 'bot')).toEqual({ ok: true, username: 'gardenbot' });
    // The base rule still decides first for a bot: the reason is not "add bot".
    expect(reason('a b', 'bot')).toBe("Usernames can't contain spaces. Use - or _ instead.");
  });

  it('is localized, never the policy English', async () => {
    await loadLocale('es-ES');
    const result = checkUsernameDraft('hash saah', es);
    expect(result).toEqual({
      ok: false,
      error: 'El nombre de usuario no puede tener espacios. Usa - o _ en su lugar.',
    });
  });
});
