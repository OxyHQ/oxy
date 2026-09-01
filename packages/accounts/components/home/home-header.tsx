import React, { useEffect, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import LottieView from 'lottie-react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Avatar } from '@oxyhq/bloom/avatar';
import lottieAnimation from '@/assets/lottie/welcomeheader_background_op1.json';
import { ThemedText } from '@/components/themed-text';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';

/** Delay before the welcome lottie is told to play, so the ref is attached. */
const LOTTIE_PLAY_DELAY_MS = 100;

interface HomeHeaderProps {
  displayName: string;
  avatarUrl: string | undefined;
  onAvatarPress: () => void;
  onSearch: (query?: string) => void;
  onPressIn: () => void;
}

/**
 * The home screen's hero header: the lottie-backed avatar, the welcome
 * greeting, the search entry point, and the quick-search chips.
 *
 * Owns the one-shot lottie play effect (previously inline on the screen).
 * Extracted from the home screen to keep it a thin composition; the rendered
 * markup and styles are unchanged.
 */
export function HomeHeader({
  displayName,
  avatarUrl,
  onAvatarPress,
  onSearch,
  onPressIn,
}: HomeHeaderProps) {
  const colors = useColors();
  const { t } = useTranslation();
  const lottieRef = useRef<LottieView>(null);
  const hasPlayedRef = useRef(false);

  const chips = useMemo(() => [
    { label: t('home.searchChips.devices'), query: 'devices' },
    { label: t('home.searchChips.security'), query: 'security' },
    { label: t('home.searchChips.activity'), query: 'activity' },
    { label: t('home.searchChips.email'), query: 'email' },
    { label: t('home.searchChips.alia'), query: 'alia' },
  ], [t]);

  useEffect(() => {
    // Play animation only once when component mounts
    if (hasPlayedRef.current) return;

    // Use a small timeout to ensure the ref is set after render
    const timer = setTimeout(() => {
      if (lottieRef.current && !hasPlayedRef.current) {
        lottieRef.current.play();
        hasPlayedRef.current = true;
      }
    }, LOTTIE_PLAY_DELAY_MS);

    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.header}>
      <View style={styles.avatarSectionWrapper}>
        <View style={styles.avatarContainer}>
          <LottieView
            autoPlay
            ref={lottieRef}
            source={lottieAnimation}
            loop
            style={styles.lottieBackground}
          />
          <TouchableOpacity
            style={styles.avatarWrapper}
            onPressIn={onPressIn}
            onPress={onAvatarPress}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={t('a11y.avatar')}
            accessibilityHint={t('a11y.avatarHint')}
          >
            <Avatar name={displayName} source={avatarUrl} size={100} />
          </TouchableOpacity>
        </View>
        <View style={styles.nameWrapper}>
          <ThemedText style={styles.welcomeText}>{displayName}</ThemedText>
          <ThemedText style={styles.welcomeSubtext}>{t('home.subtitle')}</ThemedText>
        </View>
        {/* Search Bar */}
        <TouchableOpacity
          style={[styles.searchBar, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => onSearch()}
          onPressIn={onPressIn}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('home.search')}
          accessibilityHint={t('a11y.searchHint')}
        >
          <Ionicons name="search" size={20} color={colors.icon} />
          <Text style={[styles.searchPlaceholder, { color: colors.icon }]}>{t('home.search')}</Text>
        </TouchableOpacity>
        {/* Quick Search Chips */}
        <View style={styles.searchChipsContainer}>
          {chips.map((chip) => (
            <TouchableOpacity
              key={chip.query}
              style={[styles.searchChip, { borderColor: colors.border }]}
              onPress={() => onSearch(chip.query)}
              onPressIn={onPressIn}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t('a11y.suggestion', { title: chip.label })}
            >
              <Text style={[styles.searchChipText, { color: colors.text }]}>{chip.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    marginBottom: 24,
  } as const,
  avatarContainer: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    width: 600,
    height: 100,
    overflow: 'hidden',
  } as const,
  lottieBackground: {
    position: 'absolute',
    width: 600,
    height: 100,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  } as const,
  avatarWrapper: {
    zIndex: 1,
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    width: 100,
    height: 100,
    left: 250,
    top: 0,
  } as const,
  avatarSectionWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    maxWidth: 600,
  } as const,
  nameWrapper: {
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
  } as const,
  welcomeText: {
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 8,
  } as const,
  welcomeSubtext: {
    fontSize: 16,
    fontWeight: '400',
    opacity: 0.6,
  } as const,
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 28,
    borderWidth: 1,
    width: '100%',
    maxWidth: 600,
    gap: 12,
  } as const,
  searchPlaceholder: {
    fontSize: 16,
    flex: 1,
  } as const,
  searchChipsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginTop: 16,
    gap: 8,
    maxWidth: 600,
  } as const,
  searchChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  } as const,
  searchChipText: {
    fontSize: 14,
    fontWeight: '500',
  } as const,
});
