/**
 * Minimal React Native stub for the inbox test environment.
 *
 * Only the surfaces the modules under test actually touch are stubbed. The
 * mutable `Platform.OS` lets a test flip between `web` / `ios` / `android` to
 * exercise the platform-conditional branches of the push adapter.
 */

type PlatformOS = 'ios' | 'android' | 'web' | 'windows' | 'macos';

export const Platform: {
  OS: PlatformOS;
  select: <T>(obj: Partial<Record<PlatformOS | 'default' | 'native', T>>) => T | undefined;
  Version: number;
} = {
  OS: 'ios',
  select: (obj) => {
    const os = Platform.OS;
    if (os in obj) return obj[os];
    if (os !== 'web' && 'native' in obj) return obj.native;
    return obj.default;
  },
  Version: 17,
};
