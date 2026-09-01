/**
 * Subscriptions management screen.
 *
 * Lists newsletter/mailing-list senders with unsubscribe actions,
 * similar to Gmail's "Manage subscriptions" feature.
 */

import React, { useMemo, useCallback, useState, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  useWindowDimensions,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { LinearGradient } from 'expo-linear-gradient';

import { useFloatingHeader } from '@/hooks/useFloatingHeader';
import { SubscriptionStacks } from '@/components/SubscriptionStacks';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  ArrowLeft01Icon,
  News01Icon,
} from '@hugeicons/core-free-icons';
import { useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useGoBack } from '@/hooks/useGoBack';
import { useColors } from '@/constants/theme';
import { fadeOut } from '@/utils/fadeOut';
import { useSubscriptions } from '@/hooks/queries/useSubscriptions';
import { useUnsubscribe } from '@/hooks/mutations/useUnsubscribe';
import { SubscriptionRow } from '@/components/SubscriptionRow';
import type { Subscription } from '@/services/emailApi';

interface DrawerNavigation {
  openDrawer?: () => void;
  dispatch?: (action: unknown) => void;
}

export function SubscriptionsScreen() {
  const navigation = useNavigation<DrawerNavigation>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const colors = useColors();
  const isDesktop = Platform.OS === 'web' && width >= 900;

  const {
    data,
    isLoading,
    isRefetching,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useSubscriptions();

  const unsubscribeMutation = useUnsubscribe();
  const [unsubscribingAddress, setUnsubscribingAddress] = useState<string | null>(null);

  // Offset pagination over a live aggregate: a message arriving between two
  // page fetches shifts every sender's rank, so a sender already on screen can
  // come back in the next page. Keeping the first occurrence preserves the
  // server's order — the row is identified by its sender address, so the
  // duplicate carries nothing new.
  const subscriptions = useMemo(() => {
    const seen = new Set<string>();
    const merged: Subscription[] = [];
    for (const page of data?.pages ?? []) {
      for (const sub of page.data) {
        if (seen.has(sub._id)) continue;
        seen.add(sub._id);
        merged.push(sub);
      }
    }
    return merged;
  }, [data]);

  const handleOpenDrawer = useCallback(() => {
    // Synthesize the DrawerActions.openDrawer payload inline — expo-router v56
    // rejects direct `@react-navigation/*` imports.
    if (navigation.openDrawer) {
      navigation.openDrawer();
      return;
    }
    navigation.dispatch?.({ type: 'OPEN_DRAWER' });
  }, [navigation]);

  const handleBack = useGoBack();

  const handleUnsubscribe = useCallback(
    (senderAddress: string, method?: 'list-unsubscribe' | 'block') => {
      setUnsubscribingAddress(senderAddress);
      unsubscribeMutation.mutate(
        { senderAddress, method },
        { onSettled: () => setUnsubscribingAddress(null) },
      );
    },
    [unsubscribeMutation],
  );

  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  /**
   * Tapping a pile scrolls the list to that sender — the pile is a jump target,
   * matching the header's "Scroll to <sender>" affordance.
   */
  const { headerHeight, onHeaderLayout, floatingHeaderStyle } = useFloatingHeader();
  const listRef = useRef<FlashListRef<Subscription>>(null);
  const handleSelectSubscription = useCallback(
    (subscriptionId: string) => {
      const index = subscriptions.findIndex((s) => s._id === subscriptionId);
      if (index < 0) return;
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 });
    },
    [subscriptions],
  );

  const renderItem = useCallback(
    ({ item }: { item: Subscription }) => (
      <SubscriptionRow
        subscription={item}
        onUnsubscribe={handleUnsubscribe}
        isUnsubscribing={unsubscribingAddress === item._id}
      />
    ),
    [handleUnsubscribe, unsubscribingAddress],
  );

  const renderSeparator = useCallback(
    () => (
      <View
        style={[
          styles.separator,
          {
            backgroundColor: colors.border,
            marginLeft: 16 + insets.left,
            marginRight: 16 + insets.right,
          },
        ]}
      />
    ),
    [colors.border, insets.left, insets.right],
  );

  const renderEmpty = useCallback(
    () => (
      <View style={styles.emptyContainer}>
        {Platform.OS === 'web' ? (
          <HugeiconsIcon
            icon={News01Icon as unknown as IconSvgElement}
            size={64}
            color={colors.border}
          />
        ) : (
          <MaterialCommunityIcons
            name="newspaper-variant-outline"
            size={64}
            color={colors.border}
          />
        )}
        <Text style={[styles.emptyTitle, { color: colors.text }]}>
          No subscriptions found
        </Text>
        <Text style={[styles.emptySubtitle, { color: colors.secondaryText }]}>
          Senders who email you frequently will appear here.
        </Text>
      </View>
    ),
    [colors],
  );

  const renderFooter = useCallback(
    () =>
      isFetchingNextPage ? (
        <View style={styles.footer}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      ) : null,
    [isFetchingNextPage, colors.primary],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* The header floats over the list, exactly like the inbox: the
          content scrolls behind a gradient that fades out downwards, and the
          measured height becomes the list's top padding. Before this the header
          was a solid bar with a border that pushed the list down — a second,
          unrelated scroll treatment in the same app. */}
      <View style={floatingHeaderStyle} onLayout={onHeaderLayout}
      >
      <LinearGradient
        colors={[colors.background, fadeOut(colors.background)]}
        style={[
          styles.header,
          {
            paddingLeft: 16 + insets.left,
            paddingRight: 16 + insets.right,
          },
          !isDesktop && { paddingTop: insets.top },
        ]}
      >
        {!isDesktop && (
          <TouchableOpacity
            onPress={handleBack}
            style={styles.iconButton}
          >
            {Platform.OS === 'web' ? (
              <HugeiconsIcon
                icon={ArrowLeft01Icon as unknown as IconSvgElement}
                size={24}
                color={colors.icon}
              />
            ) : (
              <MaterialCommunityIcons
                name="arrow-left"
                size={24}
                color={colors.icon}
              />
            )}
          </TouchableOpacity>
        )}
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          Subscriptions
        </Text>
      </LinearGradient>
      </View>

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlashList
          ref={listRef}
          data={subscriptions}
          renderItem={renderItem}
          ItemSeparatorComponent={renderSeparator}
          ListHeaderComponent={
            <>
              <SubscriptionStacks subscriptions={subscriptions} onSelect={handleSelectSubscription} />
              {/* Scrolls with the list rather than sitting in a fixed band:
                  only the floating header stays put, same as the inbox. */}
              {subscriptions.length > 0 && (
                <View style={styles.subtitle}>
                  <Text style={[styles.subtitleText, { color: colors.secondaryText }]}>
                    When you unsubscribe, it can take a few days to stop receiving messages
                  </Text>
                </View>
              )}
            </>
          }
          ListEmptyComponent={renderEmpty}
          ListFooterComponent={renderFooter}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.3}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching && !isFetchingNextPage}
              onRefresh={refetch}
              tintColor={colors.primary}
            />
          }
          contentContainerStyle={{
            ...(subscriptions.length === 0 ? styles.emptyListContent : null),
            paddingTop: headerHeight,
            // NativeTabs already adds bottom safe-area inset on Android, so
            // pad iOS / web explicitly to keep the last row above the home
            // indicator.
            paddingBottom: Platform.OS === 'android' ? 0 : insets.bottom,
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  // `paddingLeft` / `paddingRight` are applied inline so they can include
  // landscape `insets.left` / `insets.right` for notch protection.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingBottom: 24,
    gap: 8,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
  },
  iconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  subtitle: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  subtitleText: {
    fontSize: 13,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // `marginLeft` / `marginRight` are applied inline so they can include
  // landscape `insets.left` / `insets.right`.
  separator: {
    height: StyleSheet.hairlineWidth,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    paddingHorizontal: 16,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: 'center',
  },
  emptyListContent: {
    flexGrow: 1,
  },
  footer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
});
