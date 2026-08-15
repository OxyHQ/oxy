/**
 * OxyConsentScreen — the unified OAuth authorize/consent surface for
 * `@oxyhq/services`.
 *
 * A PURE, presentational React Native component: it renders the resolved
 * requesting-application identity, the permissions (scopes) being requested,
 * the account that will authorize the request, and the allow/deny affordances —
 * and delegates every decision back through {@link OxyConsentScreenProps.onAllow}
 * / {@link OxyConsentScreenProps.onDeny}. It performs NO data fetching and owns
 * NO session state: the caller resolves the application + scopes + user (the IdP
 * from `GET /auth/session/approve-info/:code`, Console from its own request) and
 * drives the `busy` / `error` flags. This is the RN/Bloom port of the web
 * `consent-card` (`packages/auth`), so the two consent surfaces stay in visual
 * and behavioral lockstep.
 *
 * Theming is `useTheme()` + a `StyleSheet` (the same approach as
 * {@link OxyAccountDialogScreen}) so it renders correctly in EVERY consumer, including
 * apps that do not use NativeWind. Copy is localized through {@link useI18n}
 * under the `consent.*` keys.
 */
import { useCallback } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { logger } from '@oxyhq/core';
import { Avatar } from '@oxyhq/bloom/avatar';
import { Button } from '@oxyhq/bloom/button';
import { Text } from '@oxyhq/bloom/typography';
import { useTheme } from '@oxyhq/bloom/theme';
import { useI18n } from '../hooks/useI18n';
import { LogoIcon } from './logo/LogoIcon';

/** The requesting application, resolved by the caller (never user-supplied raw). */
export interface OxyConsentApplication {
  /** Display name of the requesting application. */
  name: string;
  /** Application icon — a URL or bare file id passed straight to `<Avatar source>`. */
  iconUrl?: string;
  /** Public website of the application, shown as a link when present. */
  websiteUrl?: string;
  /** Privacy policy URL, shown as a link when present. */
  privacyPolicyUrl?: string;
  /** Terms of service URL, shown as a link when present. */
  termsUrl?: string;
  /** Human-readable publisher, used for the "Published by …" provenance line. */
  developerName?: string;
  /** True for first-party / official Oxy applications. */
  isOfficial?: boolean;
}

/** The account that will authorize the request (the currently signed-in user). */
export interface OxyConsentUser {
  /** Real display name, when the profile has one. */
  displayName?: string;
  /** Normalized handle — the sanctioned fallback when `displayName` is absent. */
  handle?: string;
  /** Avatar — a URL or bare file id passed straight to `<Avatar source>`. */
  avatarUri?: string;
}

export interface OxyConsentScreenProps {
  /** The resolved requesting application. */
  application: OxyConsentApplication;
  /** OAuth scopes requested by the client (mapped to friendly labels). */
  scopes: string[];
  /** The account that will authorize the request, when known. */
  user?: OxyConsentUser;
  /** Approve handler — the caller mints the code / completes the flow. */
  onAllow: () => void | Promise<void>;
  /** Deny handler — the caller cancels the flow. */
  onDeny: () => void;
  /** True while a decision is in flight; disables both actions and spins Allow. */
  busy?: boolean;
  /** A blocking error message for the request, when present. */
  error?: string | null;
}

/**
 * Friendly-label i18n keys for the scopes the platform issues. Standard OIDC
 * scopes (`openid` / `profile` / `email` / `offline_access`) and the Oxy scope
 * set — including the `<resource>:read` ids the API actually issues
 * (`profile:read`, `email:read`) — map to a curated `consent.scopes.*` sentence
 * that already ships in `@oxyhq/core` for all 11 locales. This is the SAME
 * vocabulary the Commons approval screen uses
 * (`packages/commons/lib/commons-signin/scope-summary.ts`), so one permission
 * reads identically wherever it is granted. Unknown scopes fall back to the raw
 * scope string so the user always sees something concrete.
 */
const SCOPE_LABEL_KEYS: Readonly<Record<string, string>> = {
  openid: 'consent.scopes.openid',
  profile: 'consent.scopes.profile',
  'profile:read': 'consent.scopes.profile',
  email: 'consent.scopes.email',
  'email:read': 'consent.scopes.email',
  offline_access: 'consent.scopes.offlineAccess',
  'user:read': 'consent.scopes.userRead',
  'files:read': 'consent.scopes.filesRead',
  'files:write': 'consent.scopes.filesWrite',
  'files:delete': 'consent.scopes.filesDelete',
  'webhooks:receive': 'consent.scopes.webhooksReceive',
  'inference:invoke': 'consent.scopes.inferenceInvoke',
  'inference:models:read': 'consent.scopes.inferenceModelsRead',
  'inference:usage:read': 'consent.scopes.inferenceUsageRead',
  'inference:routing:read': 'consent.scopes.inferenceRoutingRead',
  'inference:routing:write': 'consent.scopes.inferenceRoutingWrite',
  'inference:providers:read': 'consent.scopes.inferenceProvidersRead',
  'inference:providers:write': 'consent.scopes.inferenceProvidersWrite',
  'federation:write': 'consent.scopes.federationWrite',
};

type Translate = ReturnType<typeof useI18n>['t'];

/** One permission row of the "Permissions requested" list. */
interface PermissionRow {
  /** Stable list key / testID suffix — the first scope that produced this row. */
  scope: string;
  /** Shared `consent.scopes.*` key, absent when this build has no sentence for the scope. */
  labelKey?: string;
}

/**
 * Resolve the requested scopes into the rows the user actually reads.
 *
 * De-duplicates by RESOLVED MEANING rather than by raw string — `profile` and
 * `profile:read` are one permission and must not render as two identical rows —
 * while preserving the server's ordering. An unknown scope is never dropped: it
 * keeps its own row and renders verbatim, so a permission this build has no
 * sentence for is still shown to the person granting it.
 */
function resolvePermissionRows(scopes: readonly string[]): PermissionRow[] {
  const rows: PermissionRow[] = [];
  const seen = new Set<string>();

  for (const raw of scopes) {
    // The caller resolves scopes from the network; a non-string entry must not
    // take the whole consent surface down with a `.trim()` on it.
    if (typeof raw !== 'string') continue;
    const scope = raw.trim();
    if (!scope) continue;

    const labelKey = SCOPE_LABEL_KEYS[scope];
    const identity = labelKey ?? `raw:${scope}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    rows.push(labelKey ? { scope, labelKey } : { scope });
  }

  return rows;
}

function permissionRowLabel(row: PermissionRow, t: Translate): string {
  return row.labelKey ? t(row.labelKey) : row.scope;
}

/** A tappable legal/website link that opens the URL in the platform browser. */
function ConsentLink({
  label,
  url,
  testID,
  color,
}: {
  label: string;
  url: string;
  testID: string;
  color: string;
}) {
  const handlePress = useCallback(() => {
    // `websiteUrl`/legal URLs are application-controlled metadata rendered on a
    // high-trust surface: only ever hand web schemes to the OS.
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      logger.warn('OxyConsentScreen: invalid link URL', { url });
      return;
    }
    if (protocol !== 'https:' && protocol !== 'http:') {
      logger.warn('OxyConsentScreen: blocked non-web link scheme', { url });
      return;
    }
    Linking.openURL(url).catch((error) => {
      logger.warn('OxyConsentScreen: could not open link', { url, error });
    });
  }, [url]);
  return (
    <Pressable testID={testID} onPress={handlePress} accessibilityRole="link" style={styles.link}>
      <Text style={[styles.linkText, { color }]}>{label}</Text>
    </Pressable>
  );
}

export function OxyConsentScreen({
  application,
  scopes,
  user,
  onAllow,
  onDeny,
  busy = false,
  error = null,
}: OxyConsentScreenProps) {
  const theme = useTheme();
  const { t } = useI18n();
  const appName = application.name;
  const permissionRows = resolvePermissionRows(scopes);

  const provenanceLabel = application.isOfficial
    ? t('consent.provenance.official')
    : application.developerName
      ? t('consent.provenance.developer', { developer: application.developerName })
      : t('consent.provenance.thirdParty');

  // Display-name rule (D5): a real display name, else the normalized handle.
  const accountName = user ? user.displayName?.trim() || user.handle : undefined;

  const handleAllow = useCallback(() => {
    void onAllow();
  }, [onAllow]);

  const showLegalLinks = Boolean(application.privacyPolicyUrl || application.termsUrl);

  return (
    <ScrollView
      testID="oxy-consent-screen"
      style={styles.root}
      contentContainerStyle={styles.content}
    >
      {/* Header: requesting app ↔ Oxy identity */}
      <View style={styles.header}>
        <View style={styles.connection}>
          <Avatar source={application.iconUrl} name={appName} size={56} />
          <View style={styles.connector}>
            <View style={[styles.dot, { backgroundColor: theme.colors.border }]} />
            <View style={[styles.dot, { backgroundColor: theme.colors.border }]} />
            <View style={[styles.dot, { backgroundColor: theme.colors.border }]} />
          </View>
          <View style={[styles.logoBadge, { backgroundColor: theme.colors.backgroundSecondary ?? theme.colors.card }]}>
            <LogoIcon height={30} color={theme.colors.primary} />
          </View>
        </View>
        <Text style={[styles.title, { color: theme.colors.text }]}>
          {t('consent.title', { app: appName })}
        </Text>
        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
          {t('consent.subtitle', { app: appName })}
        </Text>
      </View>

      {/* Provenance */}
      <View style={[styles.card, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}>
        <Text testID="consent-provenance" style={[styles.provenance, { color: theme.colors.text }]}>
          {provenanceLabel}
        </Text>
        {application.websiteUrl ? (
          <ConsentLink
            testID="consent-link-website"
            label={application.websiteUrl}
            url={application.websiteUrl}
            color={theme.colors.primary}
          />
        ) : null}
      </View>

      {/* Requested permissions */}
      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>
          {t('consent.permissions.title')}
        </Text>
        <View style={[styles.card, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}>
          {permissionRows.length > 0 ? (
            permissionRows.map((row) => (
              <View key={row.scope} testID={`consent-scope-${row.scope}`} style={styles.row}>
                <View style={[styles.bullet, { backgroundColor: theme.colors.primary }]} />
                <Text style={[styles.rowText, { color: theme.colors.text }]}>
                  {permissionRowLabel(row, t)}
                </Text>
              </View>
            ))
          ) : (
            <View testID="consent-scope-basic" style={styles.row}>
              <View style={[styles.bullet, { backgroundColor: theme.colors.primary }]} />
              <Text style={[styles.rowText, { color: theme.colors.text }]}>
                {t('consent.permissions.basic')}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Authorizing account */}
      {user ? (
        <View
          testID="consent-account"
          style={[styles.accountRow, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}
        >
          <Avatar source={user.avatarUri} name={accountName} size={40} />
          <View style={styles.accountText}>
            <Text
              testID="consent-account-name"
              numberOfLines={1}
              style={[styles.accountName, { color: theme.colors.text }]}
            >
              {accountName}
            </Text>
            {user.handle && user.handle !== accountName ? (
              <Text numberOfLines={1} style={[styles.accountHandle, { color: theme.colors.textSecondary }]}>
                {user.handle}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}

      {/* Legal links */}
      {showLegalLinks ? (
        <View style={styles.linksRow}>
          {application.privacyPolicyUrl ? (
            <ConsentLink
              testID="consent-link-privacy"
              label={t('consent.links.privacy')}
              url={application.privacyPolicyUrl}
              color={theme.colors.textSecondary}
            />
          ) : null}
          {application.termsUrl ? (
            <ConsentLink
              testID="consent-link-terms"
              label={t('consent.links.terms')}
              url={application.termsUrl}
              color={theme.colors.textSecondary}
            />
          ) : null}
        </View>
      ) : null}

      {/* Blocking error */}
      {error ? (
        <View
          testID="consent-error"
          style={[styles.errorCard, { borderColor: theme.colors.error }]}
        >
          <Text style={[styles.errorText, { color: theme.colors.error }]}>{error}</Text>
        </View>
      ) : null}

      {/* Decision actions */}
      <View style={styles.actions}>
        <Button
          testID="consent-allow"
          variant="primary"
          onPress={handleAllow}
          disabled={busy}
          loading={busy}
          style={styles.actionButton}
        >
          {t('consent.allow', { app: appName })}
        </Button>
        <Button
          testID="consent-deny"
          variant="ghost"
          onPress={onDeny}
          disabled={busy}
          style={styles.actionButton}
        >
          {t('consent.deny')}
        </Button>
      </View>

      <Text style={[styles.disclaimer, { color: theme.colors.textSecondary }]}>
        {t('consent.disclaimer', { app: appName })}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    padding: 20,
    gap: 20,
  },
  header: {
    alignItems: 'center',
    gap: 12,
  },
  connection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  connector: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  logoBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  section: {
    gap: 8,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 4,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 12,
    gap: 10,
  },
  provenance: {
    fontSize: 14,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  bullet: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  rowText: {
    flex: 1,
    fontSize: 14,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 12,
  },
  accountText: {
    flex: 1,
    minWidth: 0,
  },
  accountName: {
    fontSize: 15,
    fontWeight: '600',
  },
  accountHandle: {
    fontSize: 13,
  },
  linksRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    paddingHorizontal: 4,
  },
  link: {
    alignSelf: 'flex-start',
  },
  linkText: {
    fontSize: 13,
    textDecorationLine: 'underline',
  },
  errorCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
  },
  errorText: {
    fontSize: 14,
  },
  actions: {
    gap: 12,
  },
  actionButton: {
    width: '100%',
  },
  disclaimer: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    paddingHorizontal: 4,
  },
});

export default OxyConsentScreen;
