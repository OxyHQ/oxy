import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, View, StyleSheet } from 'react-native';
import { skip } from '@oxy.so/bloom-data';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import type { PurchaseApproval, SafetyPerson, ReauthProof } from '@oxy.so/contracts';
import { useOxy } from '../context/oxyRuntimeContext';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useSupervision } from '../hooks/queries/useSupervision';
import { useSignInMethods } from '../hooks/queries/useAuthMethods';
import { useAuthStore } from '../stores/authStore';
import { useAnswer } from '../data/answer';
import {
  purchaseApproval,
  purchaseApprovals,
  purchaseMerchants,
  supervisionContacts,
  supervisionPeople,
} from '../data/supervision';
import { ReauthStep } from '../components/signIn/ReauthStep';
import { AccountFlowNote, AccountFlowNotice } from '../components/signIn/accountFlowParts';
import { OxyAuthLoading } from '../components/signIn/OxyAuthScreen';
import { PersonPicker } from '../components/supervision/PersonPicker';
import { formatApprovalAmount } from '../components/supervision/presentation';
import type { BaseScreenProps } from '../types/navigation';

type Confirmation = {
  title: string;
  description: string;
  purchase?: PurchaseApproval;
  run: (reauth: ReauthProof) => Promise<unknown>;
};
function SupervisionBody({
  onClose,
  goBack,
  navigate,
  approvalId,
  childAccountId,
}: BaseScreenProps) {
  const { oxyServices, user, activeSessionId } = useOxy(),
    { t, locale } = useI18n();
  const state = useSupervision(),
    methods = useSignInMethods();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [selectedChild, setSelectedChild] = useState<string | null>(
      typeof childAccountId === 'string' && childAccountId.length <= 128 ? childAccountId : null,
    ),
    [addingGuardian, setAddingGuardian] = useState(false),
    [addingContact, setAddingContact] = useState(false),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [purchaseId, setPurchaseId] = useState<string | null>(
      typeof approvalId === 'string' && approvalId.length <= 128 ? approvalId : null,
    ),
    [cursor, setCursor] = useState<string | undefined>();
  const accountId = user?.id ?? '';
  const sessionId = activeSessionId ?? '';
  const stateFailed = state.status === 'error';
  const own = state.value?.self;
  const childId =
    selectedChild ??
    (own?.status !== 'ended' ? own?.childAccountId : null) ??
    state.value?.children[0]?.childAccountId ??
    null;
  const guardianForChild =
    state.value?.children.some((child) => child.childAccountId === childId) ?? false;
  const contacts = useAnswer(
    supervisionContacts,
    ...(childId && !stateFailed
      ? ([oxyServices, accountId, sessionId, childId] as const)
      : ([skip] as const)),
  );
  const purchases = useAnswer(
    purchaseApprovals,
    ...(state.value && !stateFailed
      ? ([oxyServices, accountId, sessionId, cursor] as const)
      : ([skip] as const)),
  );
  const detail = useAnswer(
    purchaseApproval,
    ...(purchaseId && !stateFailed
      ? ([oxyServices, accountId, sessionId, purchaseId] as const)
      : ([skip] as const)),
  );
  const detailFailed = detail.status === 'error';
  const merchants = useAnswer(
    purchaseMerchants,
    ...(detail.value && !detailFailed && !stateFailed
      ? ([
          oxyServices,
          accountId,
          sessionId,
          detail.value.id,
          detail.value.merchantAccountIds,
        ] as const)
      : ([skip] as const)),
  );
  const merchantsReady =
    merchants.status !== 'error' &&
    !!detail.value &&
    detail.value.merchantAccountIds.every((id) =>
      merchants.value?.items.some(
        (person) => person.accountId === id && (person.displayName || person.username),
      ),
    );
  const identityIds = useMemo(
    () =>
      [
        ...new Set([
          accountId,
          ...(state.value?.children.map((child) => child.childAccountId) ?? []),
          ...(own?.guardianAccountId ? [own.guardianAccountId] : []),
          ...(state.value?.invitations.flatMap((invitation) => [
            invitation.childAccountId,
            invitation.guardianAccountId,
          ]) ?? []),
          ...(contacts.value?.items.map((contact) => contact.contactAccountId) ?? []),
        ]),
      ].filter(Boolean),
    [accountId, state.value, own?.guardianAccountId, contacts.value],
  );
  const identities = useAnswer(
    supervisionPeople,
    ...(identityIds.length > 0 && !stateFailed
      ? ([oxyServices, accountId, sessionId, identityIds] as const)
      : ([skip] as const)),
  );
  const people = new Map((identities.value ?? []).map((person) => [person.accountId, person]));
  const label = (id: string | null | undefined) => {
    const person = id ? people.get(id) : undefined;
    return (
      person?.displayName ?? (person?.username ? `@${person.username}` : t('supervision.account'))
    );
  };
  const active = () => mounted.current && useAuthStore.getState().user?.id === accountId;
  // A change reads again what it can have changed and this screen shows.
  const refreshed = () =>
    Promise.all([state.refresh(), contacts.refresh(), purchases.refresh(), detail.refresh()]);
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      if (active()) {
        await refreshed();
        setNotice(t('supervision.saved'));
      }
    } catch {
      if (active()) setError(t('supervision.changeError'));
    } finally {
      if (active()) setBusy(false);
    }
  };
  if (stateFailed)
    return (
      <View style={styles.section}>
        <AccountFlowNotice type="error">{t('supervision.loadError')}</AccountFlowNotice>
        <Button onPress={() => void state.refresh()}>{t('supervision.retry')}</Button>
      </View>
    );
  if (!state.value) return <OxyAuthLoading />;
  if (confirmation) {
    if (
      methods.isError ||
      (!methods.isLoading && !methods.data?.hasEmail && !methods.data?.hasPassword)
    )
      return (
        <View style={styles.section}>
          <AccountFlowNote>{t('supervision.reauthSetup')}</AccountFlowNote>
          <Button onPress={() => setConfirmation(null)}>{t('common.back')}</Button>
          <Button onPress={() => navigate?.('ManageAccount')}>
            {t('supervision.accountSettings')}
          </Button>
        </View>
      );
    if (!methods.data) return <OxyAuthLoading />;
    return (
      <View style={styles.screen}>
        <ReauthStep
          title={confirmation.title}
          description={confirmation.description}
          action={confirmation.purchase ? 'supervision_purchase' : 'supervision'}
          allowPassword={methods.data.hasPassword}
          totpEnabled={methods.data.totpEnabled}
          submitLabel={t('supervision.confirm')}
          secondary={{ label: t('common.cancel'), onPress: () => setConfirmation(null) }}
          onSubmit={async (reauth) => {
            if (!active()) throw new Error(t('supervision.changeError'));
            await confirmation.run(reauth);
            if (active()) {
              setConfirmation(null);
              setAddingGuardian(false);
              setAddingContact(false);
              await refreshed();
              setNotice(t('supervision.saved'));
            }
          }}
        >
          {confirmation.purchase ? <PurchaseEvidence purchase={confirmation.purchase} /> : null}
        </ReauthStep>
      </View>
    );
  }
  const selectGuardian = (person: SafetyPerson) =>
    setConfirmation({
      title: t('supervision.invite'),
      description: t('supervision.inviteConsent', {
        name: person.displayName ?? person.username ?? t('supervision.account'),
      }),
      run: (reauth) =>
        oxyServices.safety.inviteGuardian({
          guardianAccountId: person.accountId,
          consentVersion: '1',
          reauth,
        }),
    });
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <AccountFlowNote>{t('supervision.description')}</AccountFlowNote>
      {notice ? <AccountFlowNotice>{notice}</AccountFlowNotice> : null}
      {error ? <AccountFlowNotice type="error">{error}</AccountFlowNotice> : null}
      <View style={styles.section}>
        <Text style={styles.heading}>{t('supervision.yourAccount')}</Text>
        {own && own.status !== 'ended' ? (
          <>
            <Text>
              {t(
                own.status === 'orphaned' || !own.guardianAccountId
                  ? 'supervision.orphaned'
                  : 'supervision.active',
                { name: label(own.guardianAccountId) },
              )}
            </Text>
            <AccountFlowNote>{t('supervision.activeDescription')}</AccountFlowNote>
            {own.guardianAccountId ? null : (
              // No guardian holds this account: one created under supervision
              // that awaits its first (ADR 0067), or one whose guardian is gone.
              // The same invitation serves both; the server decides its effect.
              <>
                <AccountFlowNote>{t('supervision.guardianNeeded')}</AccountFlowNote>
                <Button onPress={() => setAddingGuardian(!addingGuardian)}>
                  {t('supervision.invite')}
                </Button>
              </>
            )}
            <Button appearance="plain" onPress={() => navigate?.('HelpSupport')}>
              {t('supervision.transitionHelp')}
            </Button>
          </>
        ) : (
          <>
            <Text>{t('supervision.notActive')}</Text>
            {state.value.children.length === 0 ? (
              <Button onPress={() => setAddingGuardian(!addingGuardian)}>
                {t('supervision.invite')}
              </Button>
            ) : null}
          </>
        )}
        {addingGuardian ? <PersonPicker exclude={[accountId]} onSelect={selectGuardian} /> : null}
      </View>
      {state.value.invitations.length ? (
        <View style={styles.section}>
          <Text style={styles.heading}>{t('supervision.pending')}</Text>
          <AccountFlowNote>{t('supervision.pendingDescription')}</AccountFlowNote>
          {state.value.invitations.map((invitation) => (
            <View key={invitation.id} style={styles.row}>
              <Text>
                {label(invitation.childAccountId)} → {label(invitation.guardianAccountId)}
              </Text>
              <Text>
                {t('supervision.expires', {
                  date: new Date(invitation.expiresAt).toLocaleString(locale),
                })}
              </Text>
              {invitation.guardianAccountId === accountId ? (
                <Button
                  onPress={() =>
                    setConfirmation({
                      title: t('supervision.accept'),
                      description: t('supervision.acceptConsent', {
                        name: label(invitation.childAccountId),
                      }),
                      run: (reauth) =>
                        oxyServices.safety.acceptGuardianInvitation(invitation.id, {
                          consentVersion: '1',
                          reauth,
                        }),
                    })
                  }
                >
                  {t('supervision.accept')}
                </Button>
              ) : null}
              <Button
                appearance="plain"
                disabled={busy}
                onPress={() =>
                  void run(() => oxyServices.safety.cancelGuardianInvitation(invitation.id))
                }
              >
                {t('supervision.cancelInvitation')}
              </Button>
            </View>
          ))}
        </View>
      ) : null}
      {state.value.children.length ? (
        <View style={styles.section}>
          <Text style={styles.heading}>{t('supervision.children')}</Text>
          {state.value.children.map((child) => (
            <Button
              key={child.childAccountId}
              appearance={child.childAccountId === childId ? 'solid' : 'plain'}
              onPress={() => {
                setSelectedChild(child.childAccountId);
                setAddingContact(false);
              }}
            >
              {label(child.childAccountId)}
            </Button>
          ))}
        </View>
      ) : null}
      {childId ? (
        <View style={styles.section}>
          <Text style={styles.heading}>{t('supervision.contacts', { name: label(childId) })}</Text>
          <AccountFlowNote>{t('supervision.contactsDescription')}</AccountFlowNote>
          {contacts.status === 'error' ? (
            <AccountFlowNotice type="error">{t('supervision.loadError')}</AccountFlowNotice>
          ) : (
            contacts.value?.items.map((contact) => (
              <View key={contact.contactAccountId} style={styles.row}>
                <Text>{label(contact.contactAccountId)}</Text>
                {guardianForChild ? (
                  <Button
                    appearance="plain"
                    onPress={() =>
                      setConfirmation({
                        title: t('supervision.removeContact'),
                        description: t('supervision.removeConsent', {
                          name: label(contact.contactAccountId),
                        }),
                        run: (reauth) =>
                          oxyServices.safety.revokeContact({
                            childAccountId: childId,
                            contactAccountId: contact.contactAccountId,
                            reauth,
                          }),
                      })
                    }
                  >
                    {t('supervision.removeContact')}
                  </Button>
                ) : null}
              </View>
            ))
          )}
          {contacts.value?.items.length === 0 ? <Text>{t('supervision.noContacts')}</Text> : null}
          {guardianForChild ? (
            <>
              <Button onPress={() => setAddingContact(!addingContact)}>
                {t('supervision.addContact')}
              </Button>
              {addingContact ? (
                <PersonPicker
                  exclude={[childId]}
                  onSelect={(person) =>
                    setConfirmation({
                      title: t('supervision.addContact'),
                      description: t('supervision.addConsent', {
                        name: person.displayName ?? person.username ?? t('supervision.account'),
                      }),
                      run: (reauth) =>
                        oxyServices.safety.approveContact({
                          childAccountId: childId,
                          contactAccountId: person.accountId,
                          reauth,
                        }),
                    })
                  }
                />
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}
      <View style={styles.section}>
        <Text style={styles.heading}>{t('supervision.purchases')}</Text>
        {purchases.status === 'error' ? (
          <AccountFlowNotice type="error">{t('supervision.loadError')}</AccountFlowNotice>
        ) : (
          purchases.value?.items.map((purchase) => (
            <Button key={purchase.id} appearance="plain" onPress={() => setPurchaseId(purchase.id)}>
              {purchase.summary} ·{' '}
              {formatApprovalAmount(purchase.amountMinor, purchase.currency, locale)} ·{' '}
              {t(`supervision.status.${purchase.status}`)}
            </Button>
          ))
        )}
        {purchases.value?.items.length === 0 ? <Text>{t('supervision.noPurchases')}</Text> : null}
        {purchases.value?.nextCursor ? (
          <Button onPress={() => setCursor(purchases.value?.nextCursor ?? undefined)}>
            {t('supervision.more')}
          </Button>
        ) : null}
        {cursor ? (
          <Button appearance="plain" onPress={() => setCursor(undefined)}>
            {t('supervision.firstPage')}
          </Button>
        ) : null}
        {purchaseId ? (
          detailFailed ? (
            <AccountFlowNotice type="error">{t('supervision.loadError')}</AccountFlowNotice>
          ) : detail.value ? (
            <>
              <PurchaseEvidence purchase={detail.value} />
              {detail.value.status === 'pending' &&
              state.value.children.some(
                (child) => child.childAccountId === detail.value?.childAccountId,
              ) ? (
                <View style={styles.row}>
                  <Button
                    disabled={!merchantsReady}
                    onPress={() => {
                      const purchase = detail.value;
                      if (purchase)
                        setConfirmation({
                          title: t('supervision.approvePurchase'),
                          description: t('supervision.purchaseConsent'),
                          purchase,
                          run: async (reauth) => {
                            const identities = await oxyServices.safety.people({
                              accountIds: purchase.merchantAccountIds,
                            });
                            if (
                              purchase.merchantAccountIds.some(
                                (id) =>
                                  !identities.items.some(
                                    (person) =>
                                      person.accountId === id &&
                                      (person.displayName || person.username),
                                  ),
                              )
                            )
                              throw new Error(t('supervision.merchantUnavailable'));
                            return oxyServices.safety.reviewPurchaseApproval(purchase.id, {
                              decision: 'approved',
                              reauth,
                            });
                          },
                        });
                    }}
                  >
                    {t('supervision.approvePurchase')}
                  </Button>
                  <Button
                    appearance="plain"
                    onPress={() => {
                      const purchase = detail.value;
                      if (purchase)
                        setConfirmation({
                          title: t('supervision.rejectPurchase'),
                          description: t('supervision.purchaseConsent'),
                          purchase,
                          run: (reauth) =>
                            oxyServices.safety.reviewPurchaseApproval(purchase.id, {
                              decision: 'rejected',
                              reauth,
                            }),
                        });
                    }}
                  >
                    {t('supervision.rejectPurchase')}
                  </Button>
                </View>
              ) : null}
            </>
          ) : (
            <OxyAuthLoading />
          )
        ) : null}
      </View>
      <Button appearance="plain" onPress={goBack ?? onClose}>
        {t('common.back')}
      </Button>
    </ScrollView>
  );
}
function PurchaseEvidence({ purchase }: { purchase: PurchaseApproval }) {
  const { oxyServices, user, activeSessionId } = useOxy(),
    { t, locale } = useI18n();
  const names = useAnswer(
    purchaseMerchants,
    oxyServices,
    user?.id ?? '',
    activeSessionId ?? '',
    purchase.id,
    purchase.merchantAccountIds,
  );
  const money = (amount: number) => formatApprovalAmount(amount, purchase.currency, locale);
  return (
    <View style={styles.section} testID="supervision-purchase-evidence">
      <Text style={styles.heading}>{purchase.summary}</Text>
      <Text>{t(`supervision.status.${purchase.status}`)}</Text>
      {purchase.lineItems.map((line) => (
        <View key={`${line.merchantAccountId}:${line.itemReference}`} style={styles.row}>
          <Text>{line.title}</Text>
          {line.optionsText ? <Text>{line.optionsText}</Text> : null}
          <Text>
            {t('supervision.quantity', { quantity: line.quantity })} · {money(line.unitAmountMinor)}
          </Text>
          <Text>{money(line.lineAmountMinor)}</Text>
          <Text>
            {(names.status !== 'error'
              ? (names.value?.items.find((item) => item.accountId === line.merchantAccountId)
                  ?.displayName ??
                names.value?.items.find((item) => item.accountId === line.merchantAccountId)
                  ?.username)
              : null) ?? `${t('supervision.merchantUnavailable')} (${line.merchantAccountId})`}
          </Text>
          <Text>{line.itemReference}</Text>
        </View>
      ))}
      {(
        [
          ['shipping', purchase.shippingMinor],
          ['tax', purchase.taxMinor],
          ['discount', -purchase.discountMinor],
          ['rounding', purchase.roundingAdjustmentMinor],
          ['total', purchase.amountMinor],
        ] as const
      ).map(([key, amount]) => (
        <Text key={key}>
          {t(`supervision.${key}`)}: {money(amount)}
        </Text>
      ))}
      <AccountFlowNote>{t('supervision.purchaseBound')}</AccountFlowNote>
      <Text>
        {t('supervision.expires', { date: new Date(purchase.expiresAt).toLocaleString(locale) })}
      </Text>
    </View>
  );
}
export default function SupervisionScreen(props: BaseScreenProps) {
  const { user, activeSessionId } = useOxy(),
    { t } = useI18n();
  useSurfaceHeader({ title: t('supervision.title') });
  if (user?.kind !== 'personal')
    return <AccountFlowNote>{t('supervision.personalOnly')}</AccountFlowNote>;
  return <SupervisionBody key={`${user.id}:${activeSessionId}`} {...props} />;
}
const styles = StyleSheet.create({
  screen: { padding: 20, gap: 20 },
  section: { gap: 12, paddingVertical: 12 },
  row: { gap: 6, paddingVertical: 8 },
  heading: { fontSize: 18, fontWeight: '600' },
});
