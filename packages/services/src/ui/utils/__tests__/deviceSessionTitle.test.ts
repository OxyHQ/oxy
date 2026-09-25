import type { User } from '@oxy.so/core';
import { deviceSessionTitle } from '../deviceSessionTitle';

const t = (key: string) =>
  ({
    'manageAccount.sessions.thisDevice': 'This device',
    'manageAccount.sessions.otherSession': 'Another session',
  })[key] ?? key;

describe('deviceSessionTitle', () => {
  it('never reads "undefined" when the server sends no device name (OxyHQ/oxy#1375 item 11)', () => {
    // The live response shape: no `deviceName` key at all.
    const title = deviceSessionTitle({ isCurrent: true } as never, t);
    expect(title).toBe('This device');
    expect(title).not.toContain('undefined');
  });

  it("names another session by its account, which the response does carry", () => {
    const user = { id: 'u2', username: 'bob', name: { displayName: 'Bob' } } as unknown as User;
    expect(deviceSessionTitle({ isCurrent: false, user } as never, t)).toBe('Bob');
  });

  it('falls back to a generic label when nothing names the session', () => {
    expect(deviceSessionTitle({ isCurrent: false } as never, t)).toBe('Another session');
  });

  it('keeps a real device name, marking the current one', () => {
    expect(deviceSessionTitle({ deviceName: 'Pixel 8a', isCurrent: true }, t)).toBe('Pixel 8a (This device)');
    expect(deviceSessionTitle({ deviceName: 'Pixel 8a', isCurrent: false }, t)).toBe('Pixel 8a');
  });
});
