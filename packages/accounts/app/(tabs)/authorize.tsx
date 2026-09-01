import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useOxy } from '@oxyhq/services';
import { Avatar } from '@oxyhq/bloom/avatar';
import { toast } from '@oxyhq/bloom';
import { useColors } from '@/hooks/useColors';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Button } from '@/components/ui';
import { getAccountDisplayName, getNormalizedUserHandle } from '@oxyhq/core';
import { useAvatarUrl } from '@/hooks/useAvatarUrl';
import { useTranslation } from '@/lib/i18n';

/**
 * Authorize Screen
 * 
 * This screen is opened when a third-party app requests authentication.
 * It can be opened via:
 * - Deep link: oxyaccounts://authorize?token=xxx
 * - QR code scan (which opens this screen with the token)
 */
export default function AuthorizeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token: string }>();
  const colors = useColors();
  const { t, locale } = useTranslation();
  // Auth is enforced by the `(tabs)` layout — assume a session here.
  const { oxyServices, user, activeSessionId, isTokenReady } = useOxy();

  const [isLoading, setIsLoading] = useState(true);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionInfo, setSessionInfo] = useState<{
    appId: string;
    expiresAt: string;
  } | null>(null);

  const loadSessionInfo = useCallback(async () => {
    if (!params.token) {
      setError(t('authorize.errors.noToken'));
      setIsLoading(false);
      return;
    }

    try {
      const response = await oxyServices.makeRequest(
        'GET',
        `/auth/session/status/${params.token}`,
        undefined,
        { cache: false }
      ) as {
        status: string;
        sessionToken: string;
        appId: string;
        expiresAt: string;
      };

      if (response.status !== 'pending') {
        setError(t('authorize.errors.alreadyProcessed'));
        setIsLoading(false);
        return;
      }

      setSessionInfo({
        appId: response.appId,
        expiresAt: response.expiresAt,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('authorize.errors.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [params.token, oxyServices, t]);

  // Load session info after token is ready
  useEffect(() => {
    if (isTokenReady) {
      loadSessionInfo();
    }
  }, [params.token, loadSessionInfo, isTokenReady]);

  const handleAuthorize = useCallback(async () => {
    if (!params.token) {
      setError(t('authorize.errors.noToken'));
      return;
    }

    if (!activeSessionId) {
      setError(t('authorize.errors.noSession'));
      return;
    }

    setIsAuthorizing(true);
    setError(null);

    try {
      await oxyServices.makeRequest('POST', `/auth/session/authorize/${params.token}`, {}, {
        cache: false,
        headers: {
          'x-session-id': activeSessionId,
        },
      });

      toast.success(
        t('authorize.authorizedSuccess', { app: sessionInfo?.appId || t('authorize.appFallbackInline') }),
      );
      router.back();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('authorize.errors.authorizeFailed'));
    } finally {
      setIsAuthorizing(false);
    }
  }, [params.token, activeSessionId, oxyServices, sessionInfo, router, t]);

  const handleDeny = useCallback(async () => {
    if (!params.token) return;

    try {
      await oxyServices.makeRequest('POST', `/auth/session/cancel/${params.token}`, {}, {
        cache: false,
      });
    } catch {
      // Ignore errors when cancelling
    }

    router.back();
  }, [params.token, oxyServices, router]);

  // Get user display name via the canonical helper.
  const displayName = useMemo(
    () => user?.name?.displayName ?? getNormalizedUserHandle(user) ?? getAccountDisplayName(null, locale),
    [user, locale],
  );

  // Get avatar URL
  const avatarUrl = useAvatarUrl(user);

  // Derive from theme
  const backgroundColor = colors.background;
  const textColor = colors.text;

  if (isLoading || !isTokenReady) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor }]}>
        <View style={styles.content}>
          <ActivityIndicator size="large" color={textColor} />
          <Text style={[styles.loadingText, { color: textColor, opacity: 0.8 }]}>
            {!isTokenReady ? t('authorize.preparingSession') : t('authorize.loadingRequest')}
          </Text>
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor }]}>
        <View style={styles.content}>
          <MaterialCommunityIcons name="alert-circle-outline" size={48} color={colors.error} />
          <Text style={[styles.title, { color: textColor }]}>{t('authorize.errorTitle')}</Text>
          <Text style={[styles.errorText, { color: textColor, opacity: 0.8 }]}>{error}</Text>
          <Button
            variant="secondary"
            onPress={() => router.back()}
            style={styles.fullWidthButton}
          >
            {t('authorize.goBack')}
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor }]}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.content}>
          {/* App Icon/Name Section */}
          <View style={styles.appHeader}>
            <MaterialCommunityIcons
              name="application"
              size={64}
              color={textColor}
            />
            <Text style={[styles.appName, { color: textColor }]}>
              {sessionInfo?.appId || t('authorize.appFallback')}
            </Text>
            <Text style={[styles.appRequest, { color: textColor, opacity: 0.8 }]}>
              {t('authorize.wantsToAccess')}
            </Text>
          </View>

          {/* Account summary — who you're authorizing as. */}
          <View style={styles.identityCardContainer}>
            <View style={[styles.accountSummary, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Avatar name={displayName} source={avatarUrl} size={48} />
              <View style={styles.accountSummaryText}>
                <Text style={[styles.accountSummaryName, { color: textColor }]} numberOfLines={1}>
                  {displayName}
                </Text>
                {user?.username ? (
                  <Text style={[styles.accountSummaryHandle, { color: textColor, opacity: 0.7 }]} numberOfLines={1}>
                    @{user.username}
                  </Text>
                ) : null}
              </View>
            </View>
          </View>

          {/* Permissions Section */}
          <View style={styles.permissionsSection}>
            <View style={styles.permissionsHeader}>
              <MaterialCommunityIcons
                name="shield-check-outline"
                size={20}
                color={textColor}
              />
              <Text style={[styles.permissionsTitle, { color: textColor }]}>
                {t('authorize.permissionsTitle')}
              </Text>
            </View>
            <View style={styles.permissionsList}>
              <View style={styles.permissionItem}>
                <Ionicons name="checkmark-circle" size={20} color={textColor} />
                <Text style={[styles.permissionText, { color: textColor, opacity: 0.8 }]}>
                  {t('authorize.permissionVerify')}
                </Text>
              </View>
              <View style={styles.permissionItem}>
                <Ionicons name="checkmark-circle" size={20} color={textColor} />
                <Text style={[styles.permissionText, { color: textColor, opacity: 0.8 }]}>
                  {t('authorize.permissionProfile')}
                </Text>
              </View>
            </View>
          </View>

        </View>
      </ScrollView>

      {/* Action Buttons */}
      <View style={styles.footer}>
        <Button
          variant="secondary"
          onPress={handleDeny}
          disabled={isAuthorizing}
          style={styles.button}
        >
          {t('authorize.cancel')}
        </Button>
        <Button
          variant="primary"
          onPress={handleAuthorize}
          disabled={isAuthorizing || !activeSessionId}
          loading={isAuthorizing}
          style={styles.button}
        >
          {!activeSessionId ? t('authorize.sessionNotReady') : t('authorize.continue')}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 40,
    maxWidth: 480,
    alignSelf: 'center',
    width: '100%',
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 42,
    fontWeight: Platform.OS === 'web' ? 'bold' : undefined,
    textAlign: 'center',
    marginTop: 24,
    marginBottom: 12,
    letterSpacing: -1,
  },
  subtitle: {
    fontSize: 18,
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 24,
    paddingHorizontal: 16,
  },
  appHeader: {
    alignItems: 'center',
    marginBottom: 32,
  },
  appName: {
    fontSize: 42,
    fontWeight: Platform.OS === 'web' ? 'bold' : undefined,
    marginTop: 20,
    marginBottom: 12,
    textAlign: 'center',
    letterSpacing: -1,
  },
  appRequest: {
    fontSize: 18,
    textAlign: 'center',
    lineHeight: 24,
  },
  identityCardContainer: {
    alignItems: 'center',
    marginBottom: 32,
  },
  accountSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    width: '100%',
    maxWidth: 360,
  },
  accountSummaryText: {
    flex: 1,
  },
  accountSummaryName: {
    fontSize: 16,
    fontWeight: '600',
  },
  accountSummaryHandle: {
    fontSize: 14,
    marginTop: 2,
  },
  permissionsSection: {
    marginBottom: 24,
  },
  permissionsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  permissionsTitle: {
    fontSize: 18,
    fontWeight: Platform.OS === 'web' ? '600' : undefined,
    marginLeft: 8,
    letterSpacing: -0.5,
  },
  permissionsList: {
    gap: 12,
  },
  permissionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  permissionText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
  },
  footer: {
    flexDirection: 'row',
    padding: 42,
    paddingBottom: 60,
    gap: 12,
  },
  button: {
    flex: 1,
  },
  fullWidthButton: {
    width: '100%',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 18,
    textAlign: 'center',
    lineHeight: 24,
  },
  errorText: {
    fontSize: 18,
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 24,
    paddingHorizontal: 16,
  },
});

