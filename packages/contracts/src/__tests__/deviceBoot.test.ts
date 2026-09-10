import {
    loginResultSchema,
    safeParseContract,
} from '../index';
import type {
    LoginResult,
} from '../index';

/**
 * The first-party login result contract MUST round-trip exactly what the
 * sign-in surfaces emit and what `@oxy.so/core`'s auth mixin parses, so producer
 * and consumers cannot drift. Sign-in is passkey (WebAuthn) or Commons handoff —
 * password and 2FA were removed, so the only outcome is a completed session. The
 * device transport itself is the zero-cookie `deviceId` + `deviceSecret` mint
 * (see `deviceSession.test.ts`).
 */

describe('loginResultSchema (session arm)', () => {
    it('parses the session arm', () => {
        const session: LoginResult = {
            sessionId: 's1',
            deviceId: 'd1',
            expiresAt: '2026-07-07T00:00:00.000Z',
            accessToken: 'jwt.access',
            user: { id: 'u1', username: 'nate' },
        };
        const parsed = safeParseContract(loginResultSchema, session);
        expect(parsed).not.toBeNull();
        expect(parsed && 'sessionId' in parsed && parsed.sessionId).toBe('s1');
    });

    it('parses the session arm without accessToken (optional)', () => {
        const session = {
            sessionId: 's1',
            deviceId: 'd1',
            expiresAt: '2026-07-07T00:00:00.000Z',
            user: { id: 'u1' },
        };
        expect(safeParseContract(loginResultSchema, session)).not.toBeNull();
    });

    it('parses the session arm carrying the deviceSecret (zero-cookie mint credential)', () => {
        const session: LoginResult = {
            sessionId: 's1',
            deviceId: 'd1',
            expiresAt: '2026-07-07T00:00:00.000Z',
            accessToken: 'jwt.access',
            deviceSecret: 'ds_first_secret',
            user: { id: 'u1', username: 'nate' },
        };
        const parsed = safeParseContract(loginResultSchema, session);
        expect(parsed && 'deviceSecret' in parsed && parsed.deviceSecret).toBe('ds_first_secret');
    });

    it('preserves the securityAlert on the session arm (New sign-in detected)', () => {
        const session: LoginResult = {
            sessionId: 's1',
            deviceId: 'd1',
            expiresAt: '2026-07-07T00:00:00.000Z',
            accessToken: 'jwt.access',
            securityAlert: {
                message: 'Unusual activity detected on your account',
                anomalies: [{ type: 'new_device', reason: 'first seen', details: 'Chrome / macOS' }],
            },
            user: { id: 'u1', username: 'nate' },
        };
        const parsed = safeParseContract(loginResultSchema, session);
        expect(parsed && 'securityAlert' in parsed && parsed.securityAlert?.message).toBe(
            'Unusual activity detected on your account',
        );
        expect(parsed && 'securityAlert' in parsed && parsed.securityAlert?.anomalies[0]?.type).toBe('new_device');
    });

    it('parses the session arm without a securityAlert (the common case)', () => {
        const parsed = safeParseContract(loginResultSchema, {
            sessionId: 's1',
            deviceId: 'd1',
            expiresAt: 'e',
            user: { id: 'u1' },
        });
        expect(parsed && 'securityAlert' in parsed ? parsed.securityAlert : undefined).toBeUndefined();
    });

    it('rejects a shape that is not the session arm', () => {
        expect(safeParseContract(loginResultSchema, { hello: 'world' })).toBeNull();
    });

    it('rejects a session arm missing the user', () => {
        expect(
            safeParseContract(loginResultSchema, {
                sessionId: 's1',
                deviceId: 'd1',
                expiresAt: 'e',
            }),
        ).toBeNull();
    });
});
