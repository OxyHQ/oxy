import { Admonition } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardFooter, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { CodeBlock } from '@oxy.so/bloom/code';
import { type Href, useRouter } from 'expo-router';
import { View } from 'react-native';

import { copyText } from '@/lib/clipboard';
import { useTranslation } from '@/lib/i18n';
import { usePlaygroundKey } from '@/lib/playground-key';

/**
 * Credential material shown ONCE, right after a create or a rotate.
 *
 * It lives in the parent's component state only, is cleared by the dismiss
 * button, and is never read back from anywhere: the credentials list the API
 * serves carries no secret field at all.
 *
 * `secret` and `token` are separate and both optional because exactly one of
 * them exists per credential type: `secret` for a `confidential`/`service`
 * client, `token` for a `machine` API key, neither for a `public` client. One
 * field would let an API key be rendered under the wrong label, or a `public`
 * client's `null` be copied as the string "null".
 */
export interface RevealedSecretValue {
  credentialName: string;
  publicKey: string;
  secret: string | null;
  token?: string;
}

export function RevealedSecret({
  value,
  onDismiss,
}: {
  value: RevealedSecretValue;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  // The playground's key holder: this is the only moment a machine credential's
  // bearer token exists in the browser, and `lib/playground-key.ts` says why the
  // hand-off is a memory store rather than router state or storage.
  const setPlaygroundKey = usePlaygroundKey((state) => state.setApiKey);

  const block = (code: string, filename: string, copied: string) => (
    <CodeBlock
      code={code}
      filename={filename}
      lineNumbers={false}
      wrap
      onCopy={() => copyText(code, copied)}
    />
  );

  return (
    <Card appearance="outline">
      <CardHeader>
        <CardTitle>
          {t('applications.credentials.saveSecret', { name: value.credentialName })}
        </CardTitle>
      </CardHeader>
      <CardBody>
        <View className="gap-3">
          <Admonition type="warning">{t('applications.credentials.shownOnce')}</Admonition>
          {block(
            value.publicKey,
            t('applications.credentials.clientId'),
            t('applications.credentials.clientIdCopied'),
          )}
          {value.secret
            ? block(
                value.secret,
                t('applications.credentials.secret'),
                t('applications.credentials.secretCopied'),
              )
            : null}
          {value.token
            ? block(
                value.token,
                t('applications.credentials.apiKeyLabel'),
                t('applications.credentials.apiKeyCopied'),
              )
            : null}
        </View>
      </CardBody>
      <CardFooter>
        {value.token ? (
          <Button
            appearance="outline"
            onPress={() => {
              setPlaygroundKey(value.token ?? '');
              router.push('/playground' as Href);
            }}
          >
            {t('applications.credentials.tryPlayground')}
          </Button>
        ) : null}
        <Button appearance="outline" onPress={onDismiss}>
          {t('applications.credentials.saved')}
        </Button>
      </CardFooter>
    </Card>
  );
}
