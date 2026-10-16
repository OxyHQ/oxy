import {
  agentAvailabilitySchema,
  applicationAgentSchema,
  applicationAgentWriteSchema,
} from '../index';

describe('application agents (ADR 0044)', () => {
  it('an availability is anywhere or own_application, and nothing else', () => {
    expect(applicationAgentWriteSchema.parse({ availability: 'own_application' })).toEqual({
      availability: 'own_application',
    });
    expect(applicationAgentWriteSchema.safeParse({ availability: 'everywhere' }).success).toBe(
      false,
    );
    expect(
      applicationAgentWriteSchema.safeParse({ availability: 'anywhere', applicationId: 'app-1' })
        .success,
    ).toBe(false);
  });

  it('a row names its application, its agent and who wrote it', () => {
    expect(
      applicationAgentSchema.parse({
        applicationId: 'app-1',
        agentAccountId: 'bot-1',
        availability: 'own_application',
        createdByUserId: null,
        createdAt: '2026-10-16T10:00:00.000Z',
        updatedAt: '2026-10-16T10:00:00.000Z',
      }).agentAccountId,
    ).toBe('bot-1');
  });

  it('a confined answer lists at least one application; an open one lists none', () => {
    expect(agentAvailabilitySchema.parse({ anywhere: true })).toEqual({ anywhere: true });
    expect(agentAvailabilitySchema.parse({ anywhere: false, applicationIds: ['app-1'] })).toEqual({
      anywhere: false,
      applicationIds: ['app-1'],
    });
    expect(agentAvailabilitySchema.safeParse({ anywhere: false, applicationIds: [] }).success).toBe(
      false,
    );
    expect(
      agentAvailabilitySchema.safeParse({ anywhere: true, applicationIds: ['app-1'] }).success,
    ).toBe(false);
  });
});
