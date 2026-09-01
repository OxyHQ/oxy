import React from 'react';
import { View, Image, Pressable, StyleSheet } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { LogoIcon } from '@oxyhq/services';
import type {
  CommonsApprovalInfo,
  CommonsApprovalSubjectAccount,
  PublicApplication,
} from '@oxyhq/core';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
// Imported from their own modules rather than the `components/ui` barrel: the
// barrel also exports `Screen`, which pulls Bloom's tab bar (and with it
// react-native-gesture-handler's native module) into this sheet-only surface.
import { Callout } from '@/components/ui/callout';
import { ImportantBanner } from '@/components/ui/important-banner';
import { useTranslation, type TranslateFn } from '@/lib/i18n';
import { summarizeScopes, type ScopeLine } from '@/lib/commons-signin/scope-summary';
import { formatRequestOrigin } from '@/lib/commons-signin/request-origin';
import type { ApprovalConfirmationIssue } from '@/hooks/commons-signin/useCommonsApproval';

export interface ApprovalRequestProps {
  /**
   * The whole server-resolved request context. Everything about the REQUEST
   * that this component renders is read from here — the QR / deep link / push
   * payload contributes nothing but the authorize code that resolved it.
   */
  info: CommonsApprovalInfo;
  /**
   * The requesting application, already narrowed to non-null by the caller (a
   * request whose application could not be resolved is an error, not a screen).
   */
  application: PublicApplication;
  /**
   * Display name of the LOCAL vault identity doing the approving, or `null`
   * when it has no name yet. Comes from the device's own session — never from
   * the request — because Commons is the identity, whoever is asking.
   */
  identityName: string | null;
  /** Why the local confirmation did not complete, when it did not. */
  confirmationIssue: ApprovalConfirmationIssue | null;
  onOpenLink: (url: string) => void;
}

/** How the delegated account is named: its display name, else its handle. */
function subjectLabel(subject: CommonsApprovalSubjectAccount): string {
  const displayName = subject.displayName?.trim();
  return displayName ? displayName : `@${subject.username}`;
}

/**
 * The sentence for one granted permission. Falls back to the raw scope both when
 * there is no mapping AND when the mapped sentence is missing from every
 * dictionary (`t` returns the key itself) — a permission line must never render
 * as a dotted translation key on a screen someone is granting access from.
 */
function scopeText(line: ScopeLine, t: TranslateFn): string {
  if (!line.translationKey) return line.scope;
  const label = t(line.translationKey);
  return label === line.translationKey ? line.scope : label;
}

/**
 * The Commons approval surface (issue #691, Phase 5).
 *
 * This component owns only the request content. The parent Bloom `Dialog` owns
 * every action so its primary, destructive, cancel and loading states stay
 * consistent with every other bottom sheet.
 *
 * Everything shown about the request — the application's name, icon, developer,
 * official standing, bound origin, requesting client, scopes and delegated
 * subject account — comes from `info`, which the SDK resolved server-side from
 * the authorize code. The scanned/linked payload is never a display source, so a
 * QR that self-asserts "Mention" cannot make this screen say Mention.
 *
 * The heading reads as the three lines issue #691 specifies — who is asking,
 * where from, and on what:
 *
 *     Sign in to Mention
 *     mention.earth
 *     Chrome on Windows
 *
 * The third line is dropped entirely when the server has no client to describe
 * (a native requester, an unrecognisable User-Agent). It is never guessed at,
 * because a wrong device line is worse than no device line on the one screen
 * where "was this me?" is the question being answered.
 *
 * The delegation block appears ONLY for a request that delegates to another
 * account. An ordinary personal sign-in does not grow that chrome, and when it
 * does appear it is phrased as the identity AUTHORIZING a subject account — the
 * identity never becomes the organization.
 */
export function ApprovalRequest({
  info,
  application,
  identityName,
  confirmationIssue,
  onOpenLink,
}: ApprovalRequestProps) {
  const colors = useColors();
  const { t } = useTranslation();

  const appName = application.name;
  const originHost = formatRequestOrigin(info.boundOrigin);
  const scopeLines = summarizeScopes(info.scopes);
  const subject = info.subjectAccount;
  // Anti-phishing: treat anything other than an explicit `true` as unverified
  // (false OR a missing field → warn). The reassuring "official Oxy app"
  // treatment is withheld in this state so it can't lend false legitimacy to a
  // consent-phishing lure that reuses a trusted app's branding.
  const originVerified = info.originVerified === true;
  const hasLegalLinks = Boolean(application.privacyPolicyUrl || application.termsUrl);
  const privacyPolicyUrl = application.privacyPolicyUrl;
  const termsUrl = application.termsUrl;

  return (
    <View className="pb-2">
      {/* WHO IS ASKING — server-resolved identity, paired with the Oxy mark. */}
      <View className="items-center pt-5">
        <View className="flex-row items-center gap-3">
          <View
            className="h-14 w-14 items-center justify-center overflow-hidden rounded-2xl"
            style={[styles.tile, { backgroundColor: colors.backgroundSecondary }]}
          >
            {application.icon ? (
              <Image source={{ uri: application.icon }} className="h-14 w-14" />
            ) : (
              <ThemedText style={[styles.tileInitial, { color: colors.text }]}>
                {appName.charAt(0).toUpperCase() || '?'}
              </ThemedText>
            )}
          </View>
          <MaterialCommunityIcons name="link-variant" size={18} color={colors.textTertiary} />
          <View
            className="h-14 w-14 items-center justify-center rounded-2xl"
            style={[styles.tile, { backgroundColor: colors.primarySubtle }]}
          >
            <LogoIcon height={28} color={colors.primary} />
          </View>
        </View>

        <ThemedText style={[styles.title, { color: colors.text }]}>
          {t('signInApproval.approve.title', { app: appName })}
        </ThemedText>

        {originHost ? (
          <ThemedText testID="approval-origin" style={[styles.origin, { color: colors.textSecondary }]}>
            {originHost}
          </ThemedText>
        ) : null}

        {/* WHAT IS ASKING — the server's coarse client label, verbatim. */}
        {info.requesterLabel ? (
          <ThemedText
            testID="approval-requester"
            accessibilityLabel={t('signInApproval.approve.requestedFrom', {
              client: info.requesterLabel,
            })}
            style={[styles.requester, { color: colors.textTertiary }]}
          >
            {info.requesterLabel}
          </ThemedText>
        ) : null}

        {!application.isOfficial && application.developerName ? (
          <ThemedText style={[styles.provenance, { color: colors.textTertiary }]}>
            {t('signInApproval.approve.developerBy', { developer: application.developerName })}
          </ThemedText>
        ) : null}
      </View>

      {!originVerified ? (
        <View className="pt-5">
          <ImportantBanner
            icon="alert"
            title={t('signInApproval.approve.unverifiedTitle')}
            style={styles.bannerFlush}
          >
            {t('signInApproval.approve.unverifiedBody')}
          </ImportantBanner>
        </View>
      ) : null}

      {/* DELEGATION — rendered ONLY when the request delegates to an account. */}
      {subject ? (
        <View className="pt-5">
          <View
            testID="approval-delegation"
            className="gap-3 rounded-3xl p-4"
            style={{ backgroundColor: colors.backgroundSecondary }}
          >
            <View className="gap-0.5">
              <ThemedText style={[styles.fieldLabel, { color: colors.textTertiary }]}>
                {t('signInApproval.approve.approvingWith')}
              </ThemedText>
              <ThemedText
                testID="approval-approving-with"
                style={[styles.fieldValue, { color: colors.text }]}
              >
                {identityName
                  ? t('signInApproval.approve.identityOf', { name: identityName })
                  : t('signInApproval.approve.identityYours')}
              </ThemedText>
            </View>
            <View className="gap-0.5">
              <ThemedText style={[styles.fieldLabel, { color: colors.textTertiary }]}>
                {t('signInApproval.approve.willActAs', { app: appName })}
              </ThemedText>
              <ThemedText
                testID="approval-acting-as"
                style={[styles.fieldValue, { color: colors.text }]}
              >
                {subjectLabel(subject)}
              </ThemedText>
            </View>
            <ThemedText style={[styles.fieldNote, { color: colors.textSecondary }]}>
              {t('signInApproval.approve.identityUnchanged', { app: appName })}
            </ThemedText>
          </View>
        </View>
      ) : null}

      {/* WHAT THE APP RECEIVES — server-resolved scopes, nothing implied. */}
      <View testID="approval-scopes" className="gap-2 pt-5">
        <ThemedText style={[styles.fieldLabel, { color: colors.textTertiary }]}>
          {t('signInApproval.approve.receivesTitle', { app: appName })}
        </ThemedText>
        {scopeLines.length > 0 ? (
          scopeLines.map((line) => (
            <View key={line.scope} className="flex-row items-start gap-2">
              <MaterialCommunityIcons name="check" size={16} color={colors.success} />
              <ThemedText style={[styles.scopeText, { color: colors.text }]}>
                {scopeText(line, t)}
              </ThemedText>
            </View>
          ))
        ) : (
          <View className="flex-row items-start gap-2">
            <MaterialCommunityIcons name="check" size={16} color={colors.success} />
            <ThemedText style={[styles.scopeText, { color: colors.text }]}>
              {t('signInApproval.approve.receivesBasic')}
            </ThemedText>
          </View>
        )}
      </View>

      {confirmationIssue ? (
        <View testID="approval-confirmation-issue" className="pt-3">
          <Callout tone={confirmationIssue.kind === 'declined' ? 'info' : 'danger'} icon="fingerprint">
            {t(confirmationIssueKey(confirmationIssue))}
          </Callout>
        </View>
      ) : null}

      {hasLegalLinks ? (
        <View className="flex-row flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-5">
          {privacyPolicyUrl ? (
            <Pressable onPress={() => onOpenLink(privacyPolicyUrl)} accessibilityRole="link">
              <ThemedText style={[styles.legalLink, { color: colors.textTertiary }]}>
                {t('signInApproval.approve.privacyLink')}
              </ThemedText>
            </Pressable>
          ) : null}
          {termsUrl ? (
            <Pressable onPress={() => onOpenLink(termsUrl)} accessibilityRole="link">
              <ThemedText style={[styles.legalLink, { color: colors.textTertiary }]}>
                {t('signInApproval.approve.termsLink')}
              </ThemedText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The one honest sentence for each way a local confirmation can fail to happen.
 * Each says what occurred and what the person can do about it; none of them
 * offers a way around the gate, because there isn't one.
 */
function confirmationIssueKey(issue: ApprovalConfirmationIssue): string {
  switch (issue.kind) {
    case 'unavailable':
      return issue.reason === 'no_enrollment'
        ? 'signInApproval.approve.gate.notEnrolled'
        : 'signInApproval.approve.gate.unsupported';
    case 'declined':
      return 'signInApproval.approve.gate.declined';
    case 'lockout':
      return 'signInApproval.approve.gate.lockout';
    case 'failed':
      return 'signInApproval.approve.gate.failed';
  }
}

const styles = StyleSheet.create({
  tile: {
    borderCurve: 'continuous',
  },
  tileInitial: {
    fontSize: 24,
    fontWeight: '700',
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    letterSpacing: -0.4,
    textAlign: 'center',
    marginTop: 20,
  },
  origin: {
    fontSize: 14,
    textAlign: 'center',
    marginTop: 4,
  },
  requester: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 2,
  },
  provenance: {
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 6,
  },
  bannerFlush: {
    marginBottom: 0,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
    textTransform: 'uppercase',
  },
  fieldValue: {
    fontSize: 16,
    fontWeight: '600',
  },
  fieldNote: {
    fontSize: 12,
    lineHeight: 17,
  },
  scopeText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  legalLink: {
    fontSize: 12,
    fontWeight: '600',
  },
});
