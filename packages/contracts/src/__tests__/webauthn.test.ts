import {
  webauthnLoginVerifyRequestSchema,
  webauthnRegisterVerifyRequestSchema,
} from '../webauthn';

describe('WebAuthn device metadata', () => {
  it.each([
    webauthnLoginVerifyRequestSchema,
    webauthnRegisterVerifyRequestSchema,
  ])('strips an untrusted deviceId from public verification input', (schema) => {
    expect(schema.parse({ deviceName: 'Browser', deviceId: 'victim-device' })).toEqual({
      deviceName: 'Browser',
    });
  });
});
