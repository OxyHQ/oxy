import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOxy } from '@oxy.so/services';
import { IdentityAlreadyExistsError, IdentityUnavailableError, KeyManager, SignatureService, type OpenedMnemonicIdentity } from '@oxy.so/core';
import { useColors } from '@/hooks/useColors';
import { Button } from '@/components/ui';
import { Fonts } from '@/constants/theme';
import { useTranslation } from '@/lib/i18n';
import { useIdentity } from '@/hooks/useIdentity';
import { persistOnboardingFlow } from '@/hooks/identity/identityStore';
import { IdentityMayExistError } from '@/hooks/identity/identityErrors';
import {
  awaitCode,
  confirmReceived,
  createMoveRelay,
  forgetMove,
  joinMove,
  MoveError,
  receiveIdentity,
  type IncomingMove,
} from '@/lib/identity-move/receiveMove';

const POLL_MS = 2000;

type Stage =
  | { name: 'joining' }
  | { name: 'awaiting-code'; move: IncomingMove }
  | { name: 'compare'; move: IncomingMove & { sas: string } }
  | { name: 'saving' }
  | { name: 'receipt-failed'; move: IncomingMove; synced: boolean }
  | { name: 'failed'; messageKey: string };

/**
 * Receive an identity moved from the web.
 *
 * Joins the scanned move, shows the code to compare with the computer, and
 * waits. Once the person confirms there, the identity arrives sealed to this
 * phone and is saved exactly like a phrase import; the receipt is signed with the
 * key read back from this phone's keychain, so the web learns it arrived only if
 * it was really stored. Until that receipt is sent, the web still holds the
 * identity — nothing is lost if this screen is left.
 */
export default function MoveIdentityScreen() {
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { oxyServices } = useOxy();
  const { importIdentity } = useIdentity();
  const { id } = useLocalSearchParams<{ id: string }>();
  const relay = useMemo(() => createMoveRelay(oxyServices), [oxyServices]);
  // A screen reached without a move id has nothing to join — decided on the
  // first render, not in an effect.
  const [stage, setStage] = useState<Stage>(() => (id ? { name: 'joining' } : { name: 'failed', messageKey: 'identityMove.unavailable' }));
  const identityRef = useRef<OpenedMnemonicIdentity | null>(null);

  useEffect(() => {
    void persistOnboardingFlow('import');
  }, []);

  const failWith = useCallback((error: unknown) => {
    if (error instanceof MoveError) {
      setStage({ name: 'failed', messageKey: `identityMove.${error.reason}` });
    } else if (error instanceof IdentityAlreadyExistsError) {
      setStage({ name: 'failed', messageKey: 'identityMove.identityAlreadyExists' });
    } else {
      setStage({ name: 'failed', messageKey: 'identityMove.failed' });
    }
  }, []);

  const finish = useCallback(
    (synced: boolean) => {
      identityRef.current = null;
      router.replace(synced ? '/(auth)/import-identity/username' : '/(auth)/import-identity/notifications');
    },
    [router],
  );

  const sendReceipt = useCallback(
    async (move: IncomingMove, synced: boolean) => {
      const identity = identityRef.current;
      if (!identity) return;
      setStage({ name: 'saving' });
      try {
        // Read the key back from the keychain before vouching for it: a receipt
        // must mean "stored", not "was in memory a moment ago".
        const signWithStoredKey = async (message: string) => {
          const status = await KeyManager.getIdentityStatus({ bypassCache: true });
          if (status.state !== 'present' || status.publicKey !== move.publicKey) {
            throw new Error('The identity is not stored on this phone');
          }
          return SignatureService.sign(message);
        };
        await confirmReceived(relay, move, signWithStoredKey);
      } catch {
        setStage({ name: 'receipt-failed', move, synced });
        return;
      }
      forgetMove(move);
      finish(synced);
    },
    [finish, relay],
  );

  // Join once per scanned code.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    joinMove(relay, id)
      .then((move) => {
        if (cancelled) return;
        setStage({ name: 'awaiting-code', move });
      })
      .catch((error: unknown) => {
        if (!cancelled) failWith(error);
      });
    return () => {
      cancelled = true;
    };
  }, [failWith, id, relay]);

  // Wait for the computer to reveal its key, and show the code only
  // once that key opens the commitment read before joining.
  useEffect(() => {
    if (stage.name !== 'awaiting-code') return;
    const { move } = stage;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        if (await awaitCode(relay, move)) {
          if (!stopped) setStage({ name: 'compare', move: move as IncomingMove & { sas: string } });
          return;
        }
      } catch (error) {
        if (!stopped) {
          forgetMove(move);
          failWith(error);
        }
        return;
      }
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [failWith, relay, stage]);

  // Wait for the person to confirm on the computer; one request at a time.
  useEffect(() => {
    if (stage.name !== 'compare') return;
    const { move } = stage;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      let identity: OpenedMnemonicIdentity | null;
      try {
        identity = await receiveIdentity(relay, move);
      } catch (error) {
        if (!stopped) {
          forgetMove(move);
          failWith(error);
        }
        return;
      }
      if (stopped) return;
      if (!identity) {
        timer = setTimeout(() => void tick(), POLL_MS);
        return;
      }

      stopped = true;
      setStage({ name: 'saving' });
      let synced: boolean;
      try {
        synced = (await importIdentity(identity.mnemonic)).synced;
      } catch (error) {
        forgetMove(move);
        if (error instanceof IdentityMayExistError) {
          router.replace('/(auth)/recover-identity');
          return;
        }
        if (error instanceof IdentityUnavailableError) {
          router.replace('/(auth)');
          return;
        }
        failWith(error);
        return;
      }
      identityRef.current = identity;
      await sendReceipt(move, synced);
    };

    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [failWith, importIdentity, relay, router, sendReceipt, stage]);

  const container = [styles.container, { backgroundColor: colors.background, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }];

  switch (stage.name) {
    case 'joining':
    case 'awaiting-code':
      return (
        <View style={container}>
          <Text style={[styles.body, { color: colors.text }]}>{t('identityMove.joining')}</Text>
        </View>
      );
    case 'compare':
      return (
        <View style={container}>
          <Text style={[styles.title, { color: colors.text }]}>{t('identityMove.compareTitle')}</Text>
          <Text style={[styles.body, { color: colors.text }]}>{t('identityMove.compareBody')}</Text>
          <Text
            style={[styles.sas, { color: colors.text, fontFamily: Fonts.mono }]}
            accessibilityLabel={stage.move.sas.split('').join(' ')}
          >
            {`${stage.move.sas.slice(0, 3)} ${stage.move.sas.slice(3)}`}
          </Text>
          <Text style={[styles.hint, { color: colors.text }]}>{t('identityMove.waiting')}</Text>
          <Button
            variant="ghost"
            onPress={() => {
              forgetMove(stage.move);
              router.back();
            }}
          >
            {t('common.cancel')}
          </Button>
        </View>
      );
    case 'saving':
      return (
        <View style={container}>
          <Text style={[styles.body, { color: colors.text }]}>{t('identityMove.importing')}</Text>
        </View>
      );
    case 'receipt-failed':
      return (
        <View style={container}>
          <Text style={[styles.body, { color: colors.error }]}>{t('identityMove.receiptFailed')}</Text>
          <Button variant="primary" onPress={() => void sendReceipt(stage.move, stage.synced)} style={styles.button}>
            {t('identityMove.retry')}
          </Button>
        </View>
      );
    case 'failed':
      return (
        <View style={container}>
          <Text style={[styles.body, { color: colors.error }]}>{t(stage.messageKey)}</Text>
          <Button variant="primary" onPress={() => router.replace('/(auth)/import-identity/scan')} style={styles.button}>
            {t('identityMove.scanAgain')}
          </Button>
          <Button variant="ghost" onPress={() => router.replace('/(auth)/import-identity')}>
            {t('common.back')}
          </Button>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  title: { fontSize: 32, fontWeight: '600', textAlign: 'center', marginBottom: 12, letterSpacing: -0.5 },
  body: { fontSize: 16, lineHeight: 22, textAlign: 'center' },
  sas: { fontSize: 44, letterSpacing: 4, textAlign: 'center', marginVertical: 32 },
  hint: { fontSize: 14, textAlign: 'center', opacity: 0.6, marginBottom: 24 },
  button: { marginTop: 32 },
});
