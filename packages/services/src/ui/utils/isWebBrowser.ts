/**
 * Web-browser detection for `@oxy.so/services`.
 *
 * The predicate now lives ONCE in `@oxy.so/core` (`isWebBrowser`) so services and
 * auth-sdk share the exact same DOM probe. This module re-exposes it under the
 * existing internal import path so consumers stay unchanged.
 */
export { isWebBrowser } from '@oxy.so/core';
