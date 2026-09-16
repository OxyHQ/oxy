import { Tabs } from 'expo-router/tabs';
import { TabBarMinimizeProvider } from '@oxy.so/bloom/tab-bar';

import { TestAppTabBar } from '@/components/tab-bar';

/**
 * Bottom tabs, rendered by Bloom's tab bar through the navigator's `tabBar`
 * slot — a real tab navigator underneath, so each tab keeps its state when you
 * switch. `TabBarMinimizeProvider` wraps the navigator so both the screens and
 * the bar can reach the minimize signal.
 */
export default function TabLayout() {
  return (
    <TabBarMinimizeProvider>
      <Tabs tabBar={(props) => <TestAppTabBar {...props} />} screenOptions={{ headerShown: false }}>
        <Tabs.Screen name="index" />
        <Tabs.Screen name="explore" />
      </Tabs>
    </TabBarMinimizeProvider>
  );
}
