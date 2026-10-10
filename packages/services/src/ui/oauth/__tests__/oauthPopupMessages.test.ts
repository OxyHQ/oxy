import {
  OXY_OAUTH_CODE_MESSAGE_TYPE,
  OXY_OAUTH_ERROR_MESSAGE_TYPE,
  parseOAuthPopupMessage,
  readOAuthPopupMessage,
} from '../oauthPopupMessages';
import type { OAuthPopupHandle } from '../types';

const IDP_ORIGIN = 'https://auth.oxy.so';
const STATE = 'state-abc';

/** A stand-in for the popup `Window`; identity is all the validator compares. */
function fakePopup(): OAuthPopupHandle {
  return { closed: false, close: () => undefined, location: { href: '' } };
}

/**
 * Build a `message` event with attacker-controllable fields. jsdom's
 * `MessageEvent` constructor refuses a non-`Window` `source`, so the event is
 * assembled the way the browser hands it to the listener instead.
 */
function makeMessageEvent(init: { data: unknown; origin: string; source: unknown }): MessageEvent {
  const event = new Event('message');
  Object.assign(event, init);
  return event as MessageEvent;
}

describe('parseOAuthPopupMessage', () => {
  it('accepts a well-formed code message', () => {
    expect(
      parseOAuthPopupMessage({ type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: 'c1', state: STATE }),
    ).toEqual({ type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: 'c1', state: STATE });
  });

  it('accepts a well-formed error message and its optional fields', () => {
    expect(
      parseOAuthPopupMessage({
        type: OXY_OAUTH_ERROR_MESSAGE_TYPE,
        error: 'access_denied',
        errorDescription: 'user said no',
        state: STATE,
      }),
    ).toEqual({
      type: OXY_OAUTH_ERROR_MESSAGE_TYPE,
      error: 'access_denied',
      errorDescription: 'user said no',
      state: STATE,
    });
  });

  it('drops optional error fields that are not non-empty strings', () => {
    expect(
      parseOAuthPopupMessage({
        type: OXY_OAUTH_ERROR_MESSAGE_TYPE,
        error: 'server_error',
        errorDescription: 42,
        state: '',
      }),
    ).toEqual({ type: OXY_OAUTH_ERROR_MESSAGE_TYPE, error: 'server_error' });
  });

  it('never surfaces extra properties a sender smuggled in', () => {
    const parsed = parseOAuthPopupMessage({
      type: OXY_OAUTH_CODE_MESSAGE_TYPE,
      code: 'c1',
      state: STATE,
      accessToken: 'leaked',
      deviceSecret: 'leaked',
    });
    expect(parsed).toEqual({ type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: 'c1', state: STATE });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'oxy:oauth:code'],
    ['a number', 7],
    ['an array', [{ type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: 'c', state: STATE }]],
    ['an unknown type', { type: 'oxy:oauth:token', code: 'c', state: STATE }],
    ['a code message with no code', { type: OXY_OAUTH_CODE_MESSAGE_TYPE, state: STATE }],
    [
      'a code message with an empty code',
      { type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: '', state: STATE },
    ],
    ['a code message with no state', { type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: 'c' }],
    [
      'a code message with a non-string code',
      { type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: 1, state: STATE },
    ],
    ['an error message with no error', { type: OXY_OAUTH_ERROR_MESSAGE_TYPE, state: STATE }],
  ])('rejects %s', (_label, data) => {
    expect(parseOAuthPopupMessage(data)).toBeNull();
  });
});

describe('readOAuthPopupMessage', () => {
  const popup = fakePopup();
  const context = { expectedOrigin: IDP_ORIGIN, expectedState: STATE, popup };

  it('returns the code when origin, source, shape and state all match', () => {
    const verdict = readOAuthPopupMessage(
      makeMessageEvent({
        data: { type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: 'c1', state: STATE },
        origin: IDP_ORIGIN,
        source: popup,
      }),
      context,
    );
    expect(verdict).toEqual({ kind: 'code', code: 'c1', state: STATE });
  });

  it('ignores a message from another origin, even with a valid payload', () => {
    const verdict = readOAuthPopupMessage(
      makeMessageEvent({
        data: { type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: 'evil', state: STATE },
        origin: 'https://evil.example',
        source: popup,
      }),
      context,
    );
    expect(verdict).toEqual({ kind: 'ignore' });
  });

  it('ignores a message from a window that is not the popup we opened', () => {
    const verdict = readOAuthPopupMessage(
      makeMessageEvent({
        data: { type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: 'evil', state: STATE },
        origin: IDP_ORIGIN,
        source: fakePopup(),
      }),
      context,
    );
    expect(verdict).toEqual({ kind: 'ignore' });
  });

  it('ignores a message with no source at all', () => {
    const verdict = readOAuthPopupMessage(
      makeMessageEvent({
        data: { type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: 'c1', state: STATE },
        origin: IDP_ORIGIN,
        source: null,
      }),
      context,
    );
    expect(verdict).toEqual({ kind: 'ignore' });
  });

  it('ignores a malformed payload from the real popup', () => {
    const verdict = readOAuthPopupMessage(
      makeMessageEvent({ data: { hello: 'world' }, origin: IDP_ORIGIN, source: popup }),
      context,
    );
    expect(verdict).toEqual({ kind: 'ignore' });
  });

  it('reports a state mismatch on a code message bound to another request', () => {
    const verdict = readOAuthPopupMessage(
      makeMessageEvent({
        data: { type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: 'c1', state: 'other-state' },
        origin: IDP_ORIGIN,
        source: popup,
      }),
      context,
    );
    expect(verdict).toEqual({ kind: 'state-mismatch' });
  });

  it('accepts an error message that carries no state', () => {
    const verdict = readOAuthPopupMessage(
      makeMessageEvent({
        data: { type: OXY_OAUTH_ERROR_MESSAGE_TYPE, error: 'access_denied' },
        origin: IDP_ORIGIN,
        source: popup,
      }),
      context,
    );
    expect(verdict).toEqual({ kind: 'oauth-error', error: 'access_denied' });
  });

  it('reports a state mismatch on an error message bound to another request', () => {
    const verdict = readOAuthPopupMessage(
      makeMessageEvent({
        data: { type: OXY_OAUTH_ERROR_MESSAGE_TYPE, error: 'access_denied', state: 'other' },
        origin: IDP_ORIGIN,
        source: popup,
      }),
      context,
    );
    expect(verdict).toEqual({ kind: 'state-mismatch' });
  });
});
