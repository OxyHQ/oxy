import { useState } from 'react';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { Field } from '@oxy.so/bloom/field';
import type { SurfaceControls } from '@oxy.so/bloom/surfaces';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { PROFILE_LINK_TITLE_MAX } from '@oxy.so/contracts/client';
import { useI18n } from '../hooks/useI18n';
import {
  clampLinkTitle,
  linkIdentity,
  normalizeLinkInput,
  type LinkFormResult,
  type LinkInputError,
  type LinkListItem,
} from './linkFormat';

interface ProfileLinkFormProps {
  /** The presenting surface (from `surfaces.present`); its dismiss result is the form's answer. */
  surface: SurfaceControls;
  /** The link being edited. Absent when adding one. */
  link?: LinkListItem;
  /** The addresses already on the profile, other than this link's own. */
  existingUrls: readonly string[];
}

/**
 * The form for one profile link: its address and an optional title. Saving
 * dismisses the surface with the link to keep; removing dismisses it with a
 * remove. A blank title is left blank, so the profile shows the address.
 */
export function ProfileLinkForm({ surface, link, existingUrls }: ProfileLinkFormProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(link?.url ?? '');
  const [title, setTitle] = useState(link?.title ?? '');
  const [error, setError] = useState<LinkInputError | null>(null);

  const errorMessage = (kind: LinkInputError): string => {
    switch (kind) {
      case 'empty':
        return t('editProfile.items.links.errors.empty') || 'Enter a link.';
      case 'insecure':
        return t('editProfile.items.links.errors.insecure') || 'Links must start with https://.';
      case 'already-added':
        return (
          t('editProfile.items.links.errors.duplicate') || 'That link is already on your profile.'
        );
      default:
        return t('editProfile.items.links.errors.invalid') || 'Enter a valid link.';
    }
  };

  const save = () => {
    const normalized = normalizeLinkInput(input);
    if ('error' in normalized) {
      setError(normalized.error);
      return;
    }
    const identity = linkIdentity(normalized.url);
    if (existingUrls.some((url) => linkIdentity(url) === identity)) {
      setError('already-added');
      return;
    }
    const result: LinkFormResult = {
      kind: 'save',
      url: normalized.url,
      title: clampLinkTitle(title.trim()),
    };
    surface.dismiss(result);
  };

  const remove = () => {
    const result: LinkFormResult = { kind: 'remove' };
    surface.dismiss(result);
  };

  return (
    <Card className="gap-space-16 p-space-16">
      <Field
        label={t('editProfile.items.links.form.urlLabel') || 'Link'}
        error={error ? errorMessage(error) : undefined}
      >
        <TextField>
          <TextFieldInput
            label={t('editProfile.items.links.form.urlLabel') || 'Link'}
            placeholder={t('editProfile.items.links.placeholder') || 'Enter URL'}
            value={input}
            onChangeText={(value: string) => {
              setInput(value);
              setError(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            isInvalid={error !== null}
            autoFocus={!link}
          />
        </TextField>
      </Field>
      <Field label={t('editProfile.items.links.form.titleLabel') || 'Title'}>
        <TextField>
          <TextFieldInput
            label={t('editProfile.items.links.form.titleLabel') || 'Title'}
            placeholder={t('editProfile.items.links.form.titlePlaceholder') || 'Optional'}
            value={title}
            onChangeText={(value: string) => setTitle(clampLinkTitle(value))}
            maxLength={PROFILE_LINK_TITLE_MAX}
          />
        </TextField>
      </Field>
      <View className="flex-row justify-between items-center gap-space-8">
        {link ? (
          <Button appearance="plain" tone="danger" onPress={remove}>
            {t('editProfile.items.links.form.remove') || 'Remove'}
          </Button>
        ) : (
          <View />
        )}
        <View className="flex-row gap-space-8">
          <Button appearance="subtle" tone="neutral" onPress={() => surface.dismiss()}>
            {t('common.cancel') || 'Cancel'}
          </Button>
          <Button appearance="solid" tone="accent" onPress={save}>
            {t('common.save') || 'Save'}
          </Button>
        </View>
      </View>
    </Card>
  );
}
