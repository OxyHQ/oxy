import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { parseAttestPayload } from '@oxyhq/core';
import { useOxy } from '@oxyhq/services';
import { useColors } from '@/hooks/useColors';
import { Screen, StackHeader, CenteredState, PrimaryButton, SessionGate } from '@/components/ui';
import { useAttestFlow } from '@/hooks/civic/useAttestFlow';
import type { AttestSubmitParams } from '@/hooks/civic/attestStore';
import { AttestReviewSheet, type AttestReviewStatus } from '@/components/civic/AttestReviewSheet';
import { userIdFromDid } from '@/lib/civic/did';
import { authenticate, canUseBiometrics, getErrorMessage } from '@/lib/biometricAuth';
import { useTranslation } from '@/lib/i18n';

/**
 * OS/system deep-link entry for a real-life attestation (the scanner's / B's
 * side). Reached when something outside the app opens
 * `oxycommons://attest?subject=…&ctx=…&nonce=…&exp=…` — typically the SYSTEM
 * camera scanning A's attest QR, which cold-launches straight into this route.
 * The bytes are exactly what `OxyServices.civic.buildAttestQrPayload` puts on
 * the QR. The in-app camera path routes through `app/(scan)/index.tsx` instead.
 *
 * Matches the in-app scanner: hold the payload for review in
 * `AttestReviewSheet`, then sign + submit only after B confirms and passes the
 * device biometric gate. A's identity comes ONLY from the resolved card —
 * never the tag.
 */
export default function AttestDeepLinkScreen() {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();
  const { canUsePrivateApi } = useOxy();
  const raw = useLocalSearchParams<{ subject?: string; ctx?: string; nonce?: string; exp?: string }>();

  const parsed = useMemo(
    () =>
      parseAttestPayload(
        `oxycommons://attest?subject=${encodeURIComponent(raw.subject ?? '')}` +
          `&ctx=${encodeURIComponent(raw.ctx ?? '')}` +
          `&nonce=${encodeURIComponent(raw.nonce ?? '')}` +
          `&exp=${encodeURIComponent(raw.exp ?? '')}`,
      ),
    [raw.subject, raw.ctx, raw.nonce, raw.exp],
  );

  const params = useMemo<AttestSubmitParams | null>(
    () =>
      parsed
        ? { subjectDid: parsed.subjectDid, context: parsed.context, nonce: parsed.nonce, exp: parsed.exp }
        : null,
    [parsed],
  );

  const subjectUserId = parsed ? userIdFromDid(parsed.subjectDid) : null;
  const flow = useAttestFlow(subjectUserId);

  const flowMatches = parsed !== null && flow.subjectDid === parsed.subjectDid;
  const status = flowMatches ? flow.status : 'idle';

  const [confirming, setConfirming] = useState(false);
  const preparedFor = useRef<string | null>(null);

  // Once the SDK can make private calls, hold the payload for review (one shot
  // per subject — a stable re-render or repeat tag must not re-prepare).
  useEffect(() => {
    if (!canUsePrivateApi || !params) return;
    if (preparedFor.current === params.subjectDid) return;
    preparedFor.current = params.subjectDid;
    flow.prepare(params);
  }, [canUsePrivateApi, params, flow.prepare]);

  const handleClose = useCallback(() => {
    flow.reset();
    preparedFor.current = null;
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/(id)');
  }, [flow.reset, router]);

  const handleConfirmAttest = useCallback(async () => {
    setConfirming(true);
    try {
      const canUse = await canUseBiometrics();
      if (canUse) {
        const auth = await authenticate(t('civic.attest.review.biometricReason'));
        if (!auth.success) {
          console.warn('[attest-deeplink] biometric gate not passed', getErrorMessage(auth.error));
          return;
        }
      }
      flow.confirm(canUse);
    } finally {
      setConfirming(false);
    }
  }, [flow.confirm, t]);

  const handleSheetClose = useCallback(() => {
    flow.reset();
    preparedFor.current = null;
    handleClose();
  }, [flow.reset, handleClose]);

  const renderInvalid = () => {
    const expired = parsed !== null && parsed.exp < Date.now();
    const body = expired
      ? t('signInApproval.scan.expiredBody')
      : t(`civic.attest.error.${!parsed || !subjectUserId ? 'generic' : 'subject_not_found'}`);
    return (
      <CenteredState
        icon="alert-circle-outline"
        iconColor={colors.error}
        title={t('civic.attest.confirm.error.title')}
        body={body}
        action={<PrimaryButton label={t('common.close')} onPress={handleClose} fullWidth={false} />}
      />
    );
  };

  const renderBody = () => {
    if (!parsed || !subjectUserId) {
      return renderInvalid();
    }

    if (parsed.exp < Date.now()) {
      return renderInvalid();
    }

    if (flow.subjectFailed) {
      return (
        <CenteredState
          icon="alert-circle-outline"
          iconColor={colors.error}
          title={t('civic.attest.confirm.error.title')}
          body={t('civic.attest.error.subject_not_found')}
          action={<PrimaryButton label={t('common.close')} onPress={handleClose} fullWidth={false} />}
        />
      );
    }

    if (status === 'idle' || (status === 'reviewing' && !flow.subject)) {
      return <CenteredState loading body={t('civic.attest.confirm.loading')} />;
    }

    return (
      <AttestReviewSheet
        status={status as AttestReviewStatus}
        card={flow.subject?.card ?? null}
        verified={flow.subject?.verified ?? false}
        subjectFailed={flow.subjectFailed}
        result={flow.result}
        errorCode={flow.errorCode}
        onConfirm={handleConfirmAttest}
        confirming={confirming}
        onClose={handleSheetClose}
      />
    );
  };

  return (
    <Screen gap={24}>
      <StackHeader
        title={t('civic.attest.section.title')}
        onClose={handleClose}
        closeAccessibilityLabel={t('common.close')}
      />
      <SessionGate>{renderBody()}</SessionGate>
    </Screen>
  );
}
