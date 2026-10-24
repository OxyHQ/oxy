import { z } from '@oxy.so/zod4';
import { totpBackupCodesResponseSchema } from '../signIn';
import { totpBackupCodesResponseCheck } from '../client/signIn';

it('rejects an oversized contract collection before reading an element on server and client', () => {
  const backupCodes = new Array(100_000);
  const read = jest.fn(() => {
    throw new Error('oversized input must not be walked');
  });
  Object.defineProperty(backupCodes, 0, { get: read });
  const parsed = totpBackupCodesResponseSchema.safeParse({ backupCodes });
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error('oversized backup-code collection accepted');
  expect(parsed.error.issues).toHaveLength(1);
  expect(parsed.error.issues[0]).toMatchObject({ code: 'too_big', path: ['backupCodes'] });
  const checked = totpBackupCodesResponseCheck({ backupCodes }, []);
  expect(checked.ok).toBe(false);
  if (checked.ok) throw new Error('oversized backup-code collection accepted by client');
  expect(checked.issue).toMatchObject({ code: 'too_big', path: ['backupCodes'] });
  expect(read).not.toHaveBeenCalled();
});

it.each(['array', 'set', 'map'] as const)(
  'does not run element validators for an oversized %s',
  (kind) => {
    const read = jest.fn((value: unknown) => value);
    const element = z.preprocess(read, z.string());
    const schema =
      kind === 'array'
        ? z.array(element).max(2)
        : kind === 'set'
          ? z.set(element).max(2)
          : z.map(z.string(), element).max(2);
    const values = [0, 1, 2];
    const input =
      kind === 'array'
        ? values
        : kind === 'set'
          ? new Set(values)
          : new Map(values.map((value) => [String(value), value]));
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('oversized collection accepted');
    expect(parsed.error.issues).toHaveLength(1);
    expect(parsed.error.issues[0].code).toBe('too_big');
    expect(read).not.toHaveBeenCalled();
  },
);
