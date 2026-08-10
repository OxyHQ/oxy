/**
 * The headless session runtime (ADR 0004).
 *
 * `createOxyRuntime` owns the session facts and the order in which they become
 * visible; `useRuntimeSnapshot` / `useRuntimeSelector` are the React adapter
 * over it. Nothing here imports React except the adapter, and nothing in the
 * runtime reads React state — which is what lets the provider hold ONE stable
 * reference and stop rebuilding a 58-field context value on every keystroke.
 */
export { createOxyRuntime } from './createOxyRuntime';
export type {
  OxyRuntime,
  OxyRuntimeConfig,
  RuntimeClient,
  RuntimeSessionClient,
  RuntimeSessionHost,
  SubjectTransition,
} from './createOxyRuntime';
export { useRuntimeSnapshot, useRuntimeSelector } from './useRuntimeSnapshot';
export {
  OxyRuntimeHandleProvider,
  OxyRuntimeMissingError,
  useActiveAccount,
  useDeviceDirectory,
  useOxyRuntime,
  useOxySnapshot,
} from './runtimeContext';
export type { ActiveAccount } from './runtimeContext';
export type {
  OxyRuntimeError,
  OxyRuntimeSnapshot,
  OxyRuntimeStatus,
  OxyTokenStatus,
} from './types';
