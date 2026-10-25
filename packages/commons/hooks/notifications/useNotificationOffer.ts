import { useCallback, useEffect } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  hasNotificationPermission,
  pushTokenPlatform,
  requestNotificationPermission,
} from '@oxy.so/services/notifications';

/**
 * Whether, and how, Commons may still ASK for the notification permission.
 *
 * Onboarding asks once (`app/enable-notifications.tsx`). An identity that
 * finished onboarding before that step existed was never asked, so push
 * sign-in requests could not reach the phone and nothing ever said so. This
 * offers the question once more, without nagging:
 *
 * - The ID tab shows a one-time offer while the permission is off and Commons
 *   has never asked. "Turn on" asks; "Not now" retires the offer for good. Any
 *   answer to the onboarding step retires it too.
 * - Settings keeps a permanent "Notifications" row: it asks if Commons never
 *   has, and otherwise opens the system settings (the only place an answered
 *   permission can change).
 *
 * The permission is re-read whenever Commons returns to the foreground, so a
 * change made in the system settings shows at once; `usePushRegistration`
 * registers the installation on the same signal.
 */

/** Set once Commons has asked, or the person declined to be asked. Per installation. */
export const NOTIFICATION_OFFER_ANSWERED_KEY = 'commons.notifications.offerAnswered';

export const NOTIFICATION_OFFER_QUERY_KEY = ['notifications', 'offer'] as const;

export interface NotificationOfferSnapshot {
  /** This platform has push at all (iOS and Android). */
  supported: boolean;
  granted: boolean;
  /** Commons asked, or was told "not now", before. */
  answered: boolean;
}

/** Record that the question was answered (asked, or declined to be asked). */
export async function markNotificationOfferAnswered(): Promise<void> {
  try {
    await AsyncStorage.setItem(NOTIFICATION_OFFER_ANSWERED_KEY, '1');
  } catch {
    // Best effort: at worst the one-time offer shows once more.
  }
}

export async function readNotificationOfferSnapshot(): Promise<NotificationOfferSnapshot> {
  if (!pushTokenPlatform()) {
    return { supported: false, granted: false, answered: true };
  }
  const [granted, answered] = await Promise.all([
    hasNotificationPermission(),
    AsyncStorage.getItem(NOTIFICATION_OFFER_ANSWERED_KEY).then(
      (value) => value === '1',
      () => false,
    ),
  ]);
  return { supported: true, granted, answered };
}

/** Pure: whether the one-time ID tab offer shows. */
export function showsNotificationOffer(snapshot: NotificationOfferSnapshot | undefined): boolean {
  return Boolean(snapshot?.supported && !snapshot.granted && !snapshot.answered);
}

export type NotificationRowAction = 'ask' | 'open-settings';

/** Pure: what the Settings row does when pressed. */
export function notificationRowAction(snapshot: NotificationOfferSnapshot): NotificationRowAction {
  return !snapshot.granted && !snapshot.answered ? 'ask' : 'open-settings';
}

export interface NotificationOffer {
  snapshot: NotificationOfferSnapshot | undefined;
  /** The one-time ID tab offer is due. */
  showOffer: boolean;
  /** Ask for the permission (the system dialog, at most once). Resolves granted. */
  turnOn: () => Promise<boolean>;
  /** "Not now": the offer never shows again. */
  dismiss: () => Promise<void>;
  /** The Settings row: ask when never asked, otherwise open the system settings. */
  pressSettingsRow: () => Promise<void>;
}

export function openSystemNotificationSettings(): Promise<void> {
  return (Platform.OS === 'ios' ? Linking.openURL('app-settings:') : Linking.openSettings()).catch(
    () => undefined,
  );
}

export function useNotificationOffer(): NotificationOffer {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: NOTIFICATION_OFFER_QUERY_KEY,
    queryFn: readNotificationOfferSnapshot,
    staleTime: Infinity,
    retry: false,
  });

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: NOTIFICATION_OFFER_QUERY_KEY }),
    [queryClient],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const turnOn = useCallback(async () => {
    const granted = await requestNotificationPermission();
    await markNotificationOfferAnswered();
    await refresh();
    return granted;
  }, [refresh]);

  const dismiss = useCallback(async () => {
    await markNotificationOfferAnswered();
    await refresh();
  }, [refresh]);

  const snapshot = query.data;
  const pressSettingsRow = useCallback(async () => {
    if (snapshot && notificationRowAction(snapshot) === 'ask') {
      await turnOn();
      return;
    }
    await openSystemNotificationSettings();
  }, [snapshot, turnOn]);

  return {
    snapshot,
    showOffer: showsNotificationOffer(snapshot),
    turnOn,
    dismiss,
    pressSettingsRow,
  };
}
