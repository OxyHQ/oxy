import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, View, StyleSheet } from 'react-native';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import type { PurchaseApproval, SafetyPerson, ReauthProof } from '@oxy.so/contracts';
import { useOxy } from '../context/OxyContext';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useSupervision, supervisionQueryKeys } from '../hooks/queries/useSupervision';
import { useSignInMethods } from '../hooks/queries/useAuthMethods';
import { useAuthStore } from '../stores/authStore';
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
    { t, locale } = useI18n(),
    client = useQueryClient();
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
  const own = state.data?.self;
  const childId =
    selectedChild ??
    (own?.status !== 'ended' ? own?.childAccountId : null) ??
    state.data?.children[0]?.childAccountId ??
    null;
  const guardianForChild =
    state.data?.children.some((child) => child.childAccountId === childId) ?? false;
  const contacts = useQuery({
    queryKey: ['oxy', 'safety', 'contacts', accountId, activeSessionId, childId],
    queryFn: () => {
      if (!childId) throw new Error('Select an account');
      return oxyServices.safety.contacts(childId);
    },
    enabled: !!childId && !state.isError,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const purchases = useQuery({
    queryKey: ['oxy', 'safety', 'purchases', accountId, activeSessionId, cursor],
    queryFn: () => oxyServices.safety.purchaseApprovals({ cursor }),
    enabled: !!state.data && !state.isError,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const detail = useQuery({
    queryKey: ['oxy', 'safety', 'purchase', accountId, activeSessionId, purchaseId],
    queryFn: () => {
      if (!purchaseId) throw new Error('Select a purchase');
      return oxyServices.safety.purchaseApproval(purchaseId);
    },
    enabled: !!purchaseId && !state.isError,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const merchants = useQuery({
    queryKey: [
      'oxy',
      'safety',
      'purchase-merchants',
      accountId,
      activeSessionId,
      detail.data?.id,
      detail.data?.merchantAccountIds,
    ],
    queryFn: () => {
      if (!detail.data) throw new Error('Select a purchase');
      return oxyServices.safety.people({ accountIds: detail.data.merchantAccountIds });
    },
    enabled: !!detail.data && !detail.isError && !state.isError,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const merchantsReady =
    !merchants.isError &&
    !!detail.data &&
    detail.data.merchantAccountIds.every((id) =>
      merchants.data?.items.some(
        (person) => person.accountId === id && (person.displayName || person.username),
      ),
    );
  const identityIds = useMemo(
    () =>
      [
        ...new Set([
          accountId,
          ...(state.data?.children.map((child) => child.childAccountId) ?? []),
          ...(own?.guardianAccountId ? [own.guardianAccountId] : []),
          ...(state.data?.invitations.flatMap((invitation) => [
            invitation.childAccountId,
            invitation.guardianAccountId,
          ]) ?? []),
          ...(contacts.data?.items.map((contact) => contact.contactAccountId) ?? []),
        ]),
      ].filter(Boolean),
    [accountId, state.data, own?.guardianAccountId, contacts.data],
  );
  const chunks = useMemo(
    () =>
      Array.from({ length: Math.ceil(identityIds.length / 100) }, (_, index) =>
        identityIds.slice(index * 100, index * 100 + 100),
      ),
    [identityIds],
  );
  const identities = useQueries({
    queries: chunks.map((ids) => ({
      queryKey: ['oxy', 'safety', 'people', accountId, activeSessionId, ids],
      queryFn: () => oxyServices.safety.people({ accountIds: ids }),
      staleTime: 0,
      gcTime: 0,
      retry: false,
      enabled: !state.isError,
    })),
  });
  const people = new Map(
    identities
      .flatMap((query) => (query.isError ? [] : (query.data?.items ?? [])))
      .map((person) => [person.accountId, person]),
  );
  const label = (id: string | null | undefined) => {
    const person = id ? people.get(id) : undefined;
    return (
      person?.displayName ?? (person?.username ? `@${person.username}` : t('supervision.account'))
    );
  };
  const active = () => mounted.current && useAuthStore.getState().user?.id === accountId;
  const refreshed = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: supervisionQueryKeys.all }),
      client.invalidateQueries({ queryKey: ['oxy', 'safety', 'contacts'] }),
      client.invalidateQueries({ queryKey: ['oxy', 'safety', 'purchases'] }),
      client.invalidateQueries({ queryKey: ['oxy', 'safety', 'purchase'] }),
    ]);
  };
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
  if (state.isError)
    return (
      <View style={styles.section}>
        <AccountFlowNotice type="error">{t('supervision.loadError')}</AccountFlowNotice>
        <Button onPress={() => void state.refetch()}>{t('supervision.retry')}</Button>
      </View>
    );
  if (!state.data) return <OxyAuthLoading />;
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
            <Button appearance="plain" onPress={() => navigate?.('HelpSupport')}>
              {t('supervision.transitionHelp')}
            </Button>
          </>
        ) : (
          <>
            <Text>{t('supervision.notActive')}</Text>
            {state.data.children.length === 0 ? (
              <Button onPress={() => setAddingGuardian(!addingGuardian)}>
                {t('supervision.invite')}
              </Button>
            ) : null}
          </>
        )}
        {addingGuardian ? <PersonPicker exclude={[accountId]} onSelect={selectGuardian} /> : null}
      </View>
      {state.data.invitations.length ? (
        <View style={styles.section}>
          <Text style={styles.heading}>{t('supervision.pending')}</Text>
          <AccountFlowNote>{t('supervision.pendingDescription')}</AccountFlowNote>
          {state.data.invitations.map((invitation) => (
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
      {state.data.children.length ? (
        <View style={styles.section}>
          <Text style={styles.heading}>{t('supervision.children')}</Text>
          {state.data.children.map((child) => (
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
          {contacts.isError ? (
            <AccountFlowNotice type="error">{t('supervision.loadError')}</AccountFlowNotice>
          ) : (
            contacts.data?.items.map((contact) => (
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
          {contacts.data?.items.length === 0 ? <Text>{t('supervision.noContacts')}</Text> : null}
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
        {purchases.isError ? (
          <AccountFlowNotice type="error">{t('supervision.loadError')}</AccountFlowNotice>
        ) : (
          purchases.data?.items.map((purchase) => (
            <Button key={purchase.id} appearance="plain" onPress={() => setPurchaseId(purchase.id)}>
              {purchase.summary} ·{' '}
              {formatApprovalAmount(purchase.amountMinor, purchase.currency, locale)} ·{' '}
              {t(`supervision.status.${purchase.status}`)}
            </Button>
          ))
        )}
        {purchases.data?.items.length === 0 ? <Text>{t('supervision.noPurchases')}</Text> : null}
        {purchases.data?.nextCursor ? (
          <Button onPress={() => setCursor(purchases.data?.nextCursor ?? undefined)}>
            {t('supervision.more')}
          </Button>
        ) : null}
        {cursor ? (
          <Button appearance="plain" onPress={() => setCursor(undefined)}>
            {t('supervision.firstPage')}
          </Button>
        ) : null}
        {purchaseId ? (
          detail.isError ? (
            <AccountFlowNotice type="error">{t('supervision.loadError')}</AccountFlowNotice>
          ) : detail.data ? (
            <>
              <PurchaseEvidence purchase={detail.data} />
              {detail.data.status === 'pending' &&
              state.data.children.some(
                (child) => child.childAccountId === detail.data?.childAccountId,
              ) ? (
                <View style={styles.row}>
                  <Button
                    disabled={!merchantsReady}
                    onPress={() => {
                      const purchase = detail.data;
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
                      const purchase = detail.data;
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
  const names = useQuery({
    queryKey: [
      'oxy',
      'safety',
      'purchase-merchants',
      user?.id,
      activeSessionId,
      purchase.id,
      purchase.merchantAccountIds,
    ],
    queryFn: () => oxyServices.safety.people({ accountIds: purchase.merchantAccountIds }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
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
            {(!names.isError
              ? (names.data?.items.find((item) => item.accountId === line.merchantAccountId)
                  ?.displayName ??
                names.data?.items.find((item) => item.accountId === line.merchantAccountId)
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
