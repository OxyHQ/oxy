import { appCapabilityCatalogSchema } from '@oxy.so/contracts';
import { oxyProfileCapabilityCatalog, oxyProfileToolAllowsActor } from '../oxy-profile.catalog';

describe('Oxy profile capability catalogue', () => {
  it('is a valid canonical catalogue', () => {
    const catalog = oxyProfileCapabilityCatalog();
    expect(appCapabilityCatalogSchema.parse(catalog)).toEqual(catalog);
  });

  // The ranking and the graph are the PRESENT viewer's (ADR 0025). Alia and
  // agents are told so by the catalogue itself, so a coordinator that reads
  // `actors` never offers a tool Oxy will refuse it.
  it('declares every tool executable by a present requester only', () => {
    for (const tool of oxyProfileCapabilityCatalog().tools) {
      expect(tool.actors).toEqual(['requester']);
      expect(oxyProfileToolAllowsActor(tool.name, 'requester')).toBe(true);
      expect(oxyProfileToolAllowsActor(tool.name, 'alia')).toBe(false);
      expect(oxyProfileToolAllowsActor(tool.name, 'agent')).toBe(false);
    }
  });

  it('allows nobody to execute a tool it does not list', () => {
    expect(oxyProfileToolAllowsActor('writeEmail', 'requester')).toBe(false);
  });
});
