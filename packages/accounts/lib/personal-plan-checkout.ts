import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';

const pending = new Map<string, Promise<string>>();
export function checkoutKey(accountId: string, offerId: string, version: number) {
  return `oxy.checkout.personal-plan.${encodeURIComponent(accountId)}.${encodeURIComponent(offerId)}.${version}`;
}
/** Persist BEFORE sending. Lost responses and app restarts retry the same operation. */
export function getPersonalPlanCheckoutKey(
  accountId: string,
  offerId: string,
  version: number,
): Promise<string> {
  const key = checkoutKey(accountId, offerId, version);
  const existing = pending.get(key);
  if (existing) return existing;
  const read = (async () => {
    const saved = await AsyncStorage.getItem(key);
    if (saved) return saved;
    const created = randomUUID();
    await AsyncStorage.setItem(key, created);
    return created;
  })();
  pending.set(key, read);
  void read.finally(() => pending.delete(key)).catch(() => {});
  return read;
}
export async function clearPersonalPlanCheckoutKey(
  accountId: string,
  offerId: string,
  version: number,
) {
  await AsyncStorage.removeItem(checkoutKey(accountId, offerId, version));
}
