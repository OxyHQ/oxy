import { useMemo } from 'react';
import { View, ScrollView, StyleSheet, type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '@oxy.so/bloom/theme';
import { SidebarContent } from './sidebar-content';

// The drawer navigator spreads its full `DrawerContentComponentProps` bag
// (state, descriptors, navigation, etc.) into this component. We only
// consume `navigation.closeDrawer`. Importing the upstream type directly
// causes identity conflicts because expo-router bundles its own copy of
// `@react-navigation/drawer`; structurally typing only the surface we use
// avoids that mismatch and still rejects bad call sites.
interface DrawerNavigation {
    closeDrawer: () => void;
}
interface DrawerContentProps {
    navigation: DrawerNavigation;
    state?: unknown;
    descriptors?: unknown;
}

export function DrawerContent({ navigation }: DrawerContentProps) {
    const { mode } = useTheme();
    const insets = useSafeAreaInsets();

    const gradientColors = useMemo((): readonly [ColorValue, ColorValue, ColorValue] => {
        if (mode === 'dark') {
            return ['rgba(0, 0, 0, 0.9)', 'rgba(0, 0, 0, 0.5)', 'transparent'] as const;
        }
        return ['rgba(255, 255, 255, 0.9)', 'rgba(255, 255, 255, 0.5)', 'transparent'] as const;
    }, [mode]);

    return (
        <View style={styles.container}>
            <LinearGradient
                colors={gradientColors}
                locations={[0, 0.6, 1]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={StyleSheet.absoluteFill}
            />
            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={[
                    styles.drawerContent,
                    { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 },
                ]}
            >
                <SidebarContent onNavigate={() => navigation.closeDrawer()} />
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'transparent',
    },
    scrollView: {
        backgroundColor: 'transparent',
    },
    drawerContent: {
        flex: 1,
        padding: 16,
        justifyContent: 'center',
    },
});
