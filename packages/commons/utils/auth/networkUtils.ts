import { getNetworkStateAsync } from 'expo-network';

/**
 * Check if the device is currently offline
 *
 * @returns Promise resolving to true if offline, false if online
 */
export async function checkIfOffline(): Promise<boolean> {
  try {
    const networkState = await getNetworkStateAsync();
    return !networkState.isConnected || !networkState.isInternetReachable;
  } catch {
    // If network check fails, assume offline to be safe
    return true;
  }
}
