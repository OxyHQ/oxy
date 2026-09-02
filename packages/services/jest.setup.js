// Jest setup for the services package.
//
// Notes:
//  - testEnvironment is `jsdom` so React hooks can render with React 19 + @testing-library/react.
//  - react-native is aliased to a lightweight stub under moduleNameMapper.
//  - bloom toast/etc. are aliased to a stub since we don't need real UI behavior.

const { TextDecoder, TextEncoder } = require('node:util');

// JSDOM deliberately replaces Node's globals but does not install the Encoding
// API. React Native/Hermes and browsers provide it; mirror that platform
// contract in tests before any cryptography module is evaluated.
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = TextDecoder;
}

globalThis.__DEV__ = false;

// Mock socket.io-client globally so useSessionSocket tests can intercept emitted events.
jest.mock('socket.io-client', () => {
  const sockets = [];
  const factory = () => {
    const handlers = new Map();
    const socket = {
      id: 'mock-socket',
      __handlers: handlers,
      on(event, handler) {
        const list = handlers.get(event) || [];
        list.push(handler);
        handlers.set(event, list);
        return socket;
      },
      off(event, handler) {
        const list = handlers.get(event);
        if (!list) return socket;
        if (!handler) {
          handlers.delete(event);
          return socket;
        }
        const filtered = list.filter((h) => h !== handler);
        if (filtered.length === 0) {
          handlers.delete(event);
        } else {
          handlers.set(event, filtered);
        }
        return socket;
      },
      emit(event, ...args) {
        const list = handlers.get(event);
        if (!list) return false;
        for (const h of list) h(...args);
        return true;
      },
      connect() { return socket; },
      disconnect: jest.fn(() => socket),
    };
    sockets.push(socket);
    return socket;
  };
  const io = jest.fn(() => factory());
  io.__sockets = sockets;
  io.__reset = () => {
    sockets.length = 0;
  };
  return {
    __esModule: true,
    default: io,
    io,
  };
});

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((key) => Promise.resolve(store.has(key) ? store.get(key) : null)),
      setItem: jest.fn((key, value) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      removeItem: jest.fn((key) => {
        store.delete(key);
        return Promise.resolve();
      }),
      clear: jest.fn(() => {
        store.clear();
        return Promise.resolve();
      }),
      __reset: () => store.clear(),
    },
  };
});

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

jest.setTimeout(10000);
