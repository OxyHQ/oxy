/**
 * The web domains the signed-in identity has proved it controls, held in its
 * `@oxy.so/bloom-data` store (`oxy.identity.domains.*`), and the writes that
 * prove and drop them. Memory only, as their query was.
 */
import { action, entity, list, source } from '@oxy.so/bloom-data';
import type { VerifiedDomain } from '@oxy.so/contracts';
import type { OxyServices } from '@oxy.so/core';
import { ACCOUNT_VALUE } from './accountValue';
import { sdkRead } from './readOptions';

export const Domain = entity<VerifiedDomain>('oxy.verified-domain', {
  id: (domain) => domain.domain,
});

export const Domains = list('oxy.verified-domains', { of: Domain });

/** The identity's verified domains: one list per account, under `ACCOUNT_VALUE`. */
export const domains = source(Domains, {
  ...sdkRead,
  key: (_oxy: OxyServices) => ACCOUNT_VALUE,
  stale: 5 * 60_000,
  gcTime: 30 * 60_000,
  load: async (_request, oxy) => ({ items: await oxy.identity.domains.list() }),
});

/** Starts proving a domain: resolves with the DNS record and the file to publish. */
export const requestDomainVerification = action({
  run: (oxy: OxyServices, domain: string) => oxy.identity.domains.requestVerification(domain),
});

/** Checks the published proof; a domain it verified is listed. */
export const verifyDomain = action({
  run: (oxy: OxyServices, domain: string) => oxy.identity.domains.verify(domain),
  settle: (result, oxy) => {
    if (result.verified) void domains.refresh(oxy);
  },
});

export const removeDomain = action({
  run: (oxy: OxyServices, domain: string) => oxy.identity.domains.remove(domain),
  settle: (_result, oxy) => {
    void domains.refresh(oxy);
  },
});
