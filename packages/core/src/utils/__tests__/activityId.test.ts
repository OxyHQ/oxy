import { getBrowserActivityIdHeader } from '../activityId';

describe('browser activity id', () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');

  afterAll(() => {
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
    if (originalDocumentDescriptor) {
      Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
    jest.restoreAllMocks();
  });

  it('exists only in memory in a browser runtime and rotates every five minutes', () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    expect(getBrowserActivityIdHeader()).toEqual({});

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {},
    });

    const first = getBrowserActivityIdHeader()['X-Oxy-Activity-Id'];
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    now += 5 * 60 * 1_000 - 1;
    expect(getBrowserActivityIdHeader()['X-Oxy-Activity-Id']).toBe(first);

    now += 1;
    expect(getBrowserActivityIdHeader()['X-Oxy-Activity-Id']).not.toBe(first);
  });
});
