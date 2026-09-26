/** Shared test helpers for the namespace suites. */
import { OxyServices } from '../../OxyServices';

/** An unsigned JWT carrying just a `userId` claim, far from expiry. */
export function signedInToken(userId: string): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ userId, exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
}

/** A client plus a spy on `oxy.request` — the one door every namespace goes through. */
export function stubbedClient(userId?: string): { oxy: OxyServices; request: jest.SpyInstance } {
  const oxy = new OxyServices({ baseURL: 'http://test.invalid' });
  if (userId) oxy.session.setAccessToken(signedInToken(userId));
  const request = jest.spyOn(oxy, 'request');
  return { oxy, request };
}
