import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import {
  KeyManager,
  listRetiredIdentityKeys,
  retireIdentityKey,
  retiredKeyFromPhrase,
  retiredKeyFromPrivateKey,
  type RetiredIdentityKey,
} from '@oxy.so/core/crypto';
import { useOxy } from '@oxy.so/services';
import {
  ImportantBanner,
  KeyboardAwareScrollViewWrapper,
  SettingsListItem,
  StackHeader,
} from '@/components/ui';
import { PhraseInputGrid } from '@/components/auth/PhraseInputGrid';
import { SettingsListGroup } from '@oxy.so/bloom/settings-list';
import { Icons } from '@/constants/icons';
import { RECOVERY_PHRASE_LENGTH } from '@/constants/auth';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { readPastedPhrase, WRONG_WORD_COUNT_KEY } from '@/lib/recovery-phrase/paste';

/**
 * Previous keys (oxy ADR 0061 D7 as amended 2026-11-06, Peable ADR 0002).
 *
 * After a key rotation this phone keeps the replaced key so Peable can still
 * spend the FairCoin sent to it. A phone without it — restored from the new
 * phrase, or a second phone — gets it back here, from the previous recovery
 * phrase. The phrase is checked against Oxy's record of this account's
 * replaced keys (`oxy.identity.keyHistory()`) and, only when it derives one of
 * them, the key is kept as a PREVIOUS key: never as the current one, never for
 * signing in. The phrase itself is not stored, and it never leaves the phone.
 * A previous identity imported as a raw PRIVATE KEY has no phrase: it is added
 * from that key the same way (R4-4). Once added, the encrypted backup (when
 * the person has one) is sealed again so it carries the key too.
 */
export default function PreviousKeysScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const { oxyServices } = useOxy();
  const [held, setHeld] = useState<RetiredIdentityKey[] | null>(null);
  const [words, setWords] = useState<string[]>(() => new Array(RECOVERY_PHRASE_LENGTH).fill(''));
  const [problem, setProblem] = useState<string | null>(null);
  const [mode, setMode] = useState<'phrase' | 'privateKey'>('phrase');
  const [privateKeyText, setPrivateKeyText] = useState('');
  const [working, setWorking] = useState(false);

  const refresh = useCallback(async () => {
    const [keys, current] = await Promise.all([
      listRetiredIdentityKeys(),
      KeyManager.getPublicKey().catch(() => null),
    ]);
    const currentKey = current ? KeyManager.canonicalPublicKey(current) : null;
    setHeld(keys.filter((key) => key.publicKey !== currentKey));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onWordChange = useCallback((index: number, word: string) => {
    setProblem(null);
    setWords((current) =>
      current.map((value, i) => (i === index ? word.toLowerCase().trim() : value)),
    );
  }, []);

  const onPaste = useCallback(
    (text: string) => {
      const pasted = readPastedPhrase(text);
      if (pasted.ok) {
        setWords(pasted.words);
        setProblem(null);
      } else {
        setProblem(t(WRONG_WORD_COUNT_KEY, { count: pasted.count }));
      }
    },
    [t],
  );

  const submit = useCallback(async () => {
    if (!oxyServices) return;
    setWorking(true);
    setProblem(null);
    try {
      let key: { privateKey: string; publicKey: string };
      try {
        key =
          mode === 'phrase'
            ? await retiredKeyFromPhrase(words.join(' '))
            : retiredKeyFromPrivateKey(privateKeyText);
      } catch {
        setProblem(
          t(mode === 'phrase' ? 'previousKeys.invalid' : 'previousKeys.invalidPrivateKey'),
        );
        return;
      }
      const history = await oxyServices.identity.keyHistory();
      const wanted = key.publicKey.toLowerCase();
      if (history.publicKey?.toLowerCase() === wanted) {
        setProblem(t(mode === 'phrase' ? 'previousKeys.isCurrent' : 'previousKeys.isCurrentKey'));
        return;
      }
      if (!history.retired.some((entry) => entry.publicKey.toLowerCase() === wanted)) {
        setProblem(t(mode === 'phrase' ? 'previousKeys.notYours' : 'previousKeys.notYoursKey'));
        return;
      }
      await retireIdentityKey(key);
      setWords(new Array(RECOVERY_PHRASE_LENGTH).fill(''));
      setPrivateKeyText('');
      toast.success(t('previousKeys.added'));
      await refresh();
      // Re-seal the encrypted backup so it carries this key too (R4-4). Only
      // when the person has one and this phone holds the current phrase.
      try {
        const [status, phrase] = await Promise.all([
          oxyServices.identity.backup.status(),
          KeyManager.getRecoveryMnemonic(),
        ]);
        if (status.exists && phrase) await oxyServices.identity.backup.create(phrase);
      } catch {
        toast.error(t('previousKeys.backupNotUpdated'));
      }
    } catch {
      setProblem(t('previousKeys.error'));
    } finally {
      setWorking(false);
    }
  }, [mode, oxyServices, privateKeyText, refresh, t, words]);

  const complete =
    mode === 'phrase'
      ? words.every((word) => word.trim().length > 0)
      : privateKeyText.trim().length > 0;

  return (
    <KeyboardAwareScrollViewWrapper
      reserveTabBarFootprint
      reserveTopInset
      contentContainerStyle={styles.content}
    >
      <StackHeader
        title={t('previousKeys.title')}
        subtitle={t('previousKeys.subtitle')}
        onBack={() => router.back()}
        backAccessibilityLabel={t('common.back')}
      />

      <Admonition type="info">{t('previousKeys.explainer')}</Admonition>

      {held && held.length > 0 ? (
        <SettingsListGroup title={t('previousKeys.heldTitle')}>
          {held.map((key) => (
            <SettingsListItem
              key={key.publicKey}
              icon={<Icons.history size="md" fill={colors.text} />}
              title={KeyManager.shortenPublicKey(key.publicKey)}
              description={t('previousKeys.heldItem')}
            />
          ))}
        </SettingsListGroup>
      ) : held ? (
        <Text style={[styles.empty, { color: colors.textSecondary }]}>
          {t('previousKeys.none')}
        </Text>
      ) : null}

      <View style={styles.form}>
        <Text style={[styles.formTitle, { color: colors.text }]}>
          {t(mode === 'phrase' ? 'previousKeys.addTitle' : 'previousKeys.addPrivateKeyTitle')}
        </Text>
        {mode === 'phrase' ? (
          <PhraseInputGrid
            words={words}
            onWordChange={onWordChange}
            onPaste={onPaste}
            editable={!working}
          />
        ) : (
          <TextInput
            value={privateKeyText}
            onChangeText={(text) => {
              setProblem(null);
              setPrivateKeyText(text);
            }}
            editable={!working}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder={t('previousKeys.privateKeyPlaceholder')}
            placeholderTextColor={colors.textSecondary}
            style={[styles.keyInput, { color: colors.text, borderColor: colors.border }]}
            testID="previous-key-private-key"
          />
        )}
        <Button
          appearance="plain"
          onPress={() => {
            setProblem(null);
            setMode((m) => (m === 'phrase' ? 'privateKey' : 'phrase'));
          }}
          disabled={working}
        >
          {t(mode === 'phrase' ? 'previousKeys.usePrivateKey' : 'previousKeys.usePhrase')}
        </Button>
        {problem ? <ImportantBanner type="error">{problem}</ImportantBanner> : null}
        <Button
          appearance="solid"
          tone="accent"
          onPress={() => void submit()}
          loading={working}
          disabled={working || !complete}
          testID="previous-key-add"
        >
          {working ? t('previousKeys.working') : t('previousKeys.submit')}
        </Button>
      </View>
    </KeyboardAwareScrollViewWrapper>
  );
}

const styles = StyleSheet.create({
  content: { padding: 22, paddingTop: 24, gap: 16 },
  form: { gap: 12 },
  formTitle: { fontSize: 15, fontWeight: '600' },
  keyInput: { borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 14 },
  empty: { fontSize: 13 },
});
