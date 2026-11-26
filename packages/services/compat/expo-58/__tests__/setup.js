const { TextDecoder, TextEncoder } = require('node:util');

globalThis.TextEncoder ??= TextEncoder;
globalThis.TextDecoder ??= TextDecoder;
globalThis.fetch = () => Promise.reject(new TypeError('Network request failed'));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
