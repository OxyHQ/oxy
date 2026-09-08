import { createDeferredProductAnalytics, type ProductAnalytics } from '@oxyhq/services';

const key = process.env.EXPO_PUBLIC_POSTHOG_KEY?.trim();
const enabled = process.env.EXPO_PUBLIC_POSTHOG_ENABLED === 'true' && Boolean(key);

export const productAnalytics: ProductAnalytics | undefined = enabled && key
  ? createDeferredProductAnalytics(async () => {
      const { default: PostHog } = await import('posthog-react-native');
      const client = new PostHog(key, {
        host: 'https://eu.i.posthog.com',
        captureAppLifecycleEvents: false,
        capturePushNotificationOpened: false,
        capturePushNotificationSubscriptions: false,
        enableSessionReplay: false,
        personProfiles: 'identified_only',
      });
      return {
        capture: (event, properties) => client.capture(event, properties ? { ...properties } : undefined),
        identify: (distinctId) => client.identify(distinctId),
        reset: () => client.reset(),
      };
    })
  : undefined;
