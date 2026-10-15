import {
  audienceRefusal,
  KAANA_CONTROL_APPLICATION_ID,
  KAANA_CONTROL_AUDIENCE,
  KAANA_PUBLIC_AUDIENCE,
  OXY_API_AUDIENCE,
} from '../serviceTokenAudiences';
import { KAANA_APPLICATION_ID } from '../../scripts/seedOxyApplicationsSpecs';

describe('service-token audiences (Kaana ADR 0002)', () => {
  it('pins the control audience to the seeded Kaana application', () => {
    expect(KAANA_CONTROL_APPLICATION_ID).toBe(KAANA_APPLICATION_ID);
  });

  it('admits oxy-api for any application, as before', () => {
    expect(audienceRefusal(OXY_API_AUDIENCE, 'any-app', [])).toBeUndefined();
  });

  it('admits kaana.ai only with inference:invoke among the minted scopes', () => {
    expect(audienceRefusal(KAANA_PUBLIC_AUDIENCE, 'any-app', ['inference:invoke'])).toBeUndefined();
    expect(audienceRefusal(KAANA_PUBLIC_AUDIENCE, 'any-app', ['user:read'])).toBe(
      'kaana_requires_inference_scope',
    );
  });

  it("admits Kaana's control audience to the Kaana application alone", () => {
    expect(audienceRefusal(KAANA_CONTROL_AUDIENCE, KAANA_APPLICATION_ID, [])).toBeUndefined();
    expect(audienceRefusal(KAANA_CONTROL_AUDIENCE, 'any-app', ['inference:invoke'])).toBe(
      'kaana_control_reserved',
    );
  });
});
