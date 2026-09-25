import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether a screen reader (TalkBack, VoiceOver) is running, kept current as the
 * user toggles it. For surfaces whose primary interaction is spatial (a physics
 * canvas, a gesture) and needs an accessible equivalent rather than labels.
 */
export function useScreenReaderEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((value) => {
        if (mounted) setEnabled(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', (value) => {
      setEnabled(value);
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return enabled;
}
