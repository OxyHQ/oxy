import { describe, expect, test } from 'bun:test';
import { showsAccountChoice } from '../authorize-account-choice';

const base = {
  isMcpOAuth: true,
  actionable: true,
  chooserDismissed: false,
  hasActiveContext: true,
  contextCount: 1,
};

describe('showsAccountChoice', () => {
  test('an external MCP grant always shows the chooser, even with one account', () => {
    expect(showsAccountChoice(base)).toBe(true);
  });

  test('an external MCP grant shows it with a session but no active device context', () => {
    // The state that used to end in "We couldn't load the details of this request".
    expect(showsAccountChoice({ ...base, hasActiveContext: false, contextCount: 0 })).toBe(true);
  });

  test('never for a finished request or once the choice is made', () => {
    expect(showsAccountChoice({ ...base, actionable: false })).toBe(false);
    expect(showsAccountChoice({ ...base, chooserDismissed: true })).toBe(false);
  });

  test('ordinary OAuth shows it only for several accounts on an active device', () => {
    const oauth = { ...base, isMcpOAuth: false };
    expect(showsAccountChoice({ ...oauth, contextCount: 1 })).toBe(false);
    expect(showsAccountChoice({ ...oauth, contextCount: 2 })).toBe(true);
    expect(showsAccountChoice({ ...oauth, contextCount: 2, hasActiveContext: false })).toBe(false);
  });
});
