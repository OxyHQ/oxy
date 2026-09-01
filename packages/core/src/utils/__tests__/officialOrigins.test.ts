import {
  isAllowedDeviceJoinOrigin,
  isLoopbackOrigin,
  isOfficialWebOrigin,
} from '../officialOrigins';

describe('officialOrigins', () => {
  it('allows official first-party origins', () => {
    expect(isOfficialWebOrigin('https://inbox.oxy.so')).toBe(true);
    expect(isOfficialWebOrigin('https://mention.earth')).toBe(true);
    expect(isOfficialWebOrigin('https://evil.example')).toBe(false);
  });

  it('flags loopback / local-dev origins on any port', () => {
    expect(isLoopbackOrigin('http://localhost:3000')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:8081')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:19006')).toBe(true);
    expect(isLoopbackOrigin('https://localhost')).toBe(true);
    expect(isLoopbackOrigin('https://accounts.oxy.so')).toBe(false);
    expect(isLoopbackOrigin('https://evil.example')).toBe(false);
  });

  it('treats loopback as an official origin (loopback dev is trusted)', () => {
    expect(isOfficialWebOrigin('http://localhost:3000')).toBe(true);
  });

  it('keeps the deprecated alias in sync with isOfficialWebOrigin', () => {
    expect(isAllowedDeviceJoinOrigin('https://accounts.oxy.so')).toBe(true);
    expect(isAllowedDeviceJoinOrigin('https://evil.example')).toBe(false);
  });
});
