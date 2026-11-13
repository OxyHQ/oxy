import { Pressable, Text, View } from 'react-native';

/**
 * Minimal top-level error UI. Deliberately built from plain RN primitives (no
 * Bloom / theme dependency) so it still renders if a provider is the crash
 * source. Wired via the `ErrorBoundary` export in `app/_layout.tsx`.
 */
export function ErrorFallback({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        backgroundColor: '#0b0b0c',
      }}
    >
      <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '600', marginBottom: 8 }}>
        Something went wrong
      </Text>
      <Text style={{ color: '#9b9ba3', textAlign: 'center', marginBottom: 20 }}>{error.message}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={retry}
        style={{ backgroundColor: '#5b3df5', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 }}
      >
        <Text style={{ color: '#ffffff', fontWeight: '600' }}>Try again</Text>
      </Pressable>
    </View>
  );
}
