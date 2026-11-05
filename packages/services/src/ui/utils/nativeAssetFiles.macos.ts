import type { OxyServices } from '@oxy.so/core';

/** Web/Node use their existing Blob transport. Metro selects the native adapter. */
export function installNativeAssetFiles(_oxy: OxyServices): undefined {
  return undefined;
}
