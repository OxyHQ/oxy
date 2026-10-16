/**
 * "Choose an account" after an email was proven — the email holds several
 * accounts, and the code or the link just proved the mailbox they share.
 *
 * Presentational, and the same rounded list as `OxyAccountPicker`: each row is
 * the account's name and `@handle` on the left, its avatar and a chevron on the
 * right. The host signs the chosen account in (`oxy.auth.email.choose`).
 */

import type React from 'react';
import { Fragment, useState } from 'react';
import { ScrollView } from 'react-native';
import { Pressable, View } from 'react-native-css/components';
import { Avatar } from '@oxy.so/bloom/avatar';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { SpinnerIcon } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import type { EmailSignInAccountOption } from '@oxy.so/contracts';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { useOxy } from '../../context/OxyContext';

/** The list scrolls past this height (`max-h-96`). */
const LIST_MAX_HEIGHT = 384;
const AVATAR_SIZE = 40;

export interface OxyEmailAccountChoiceProps {
  accounts: EmailSignInAccountOption[];
  onChoose: (account: EmailSignInAccountOption) => void;
  /** The account being signed in, whose row shows it is busy. */
  pendingId?: string | null;
  /** Disables every row while a choice is in flight. */
  disabled?: boolean;
}

export const OxyEmailAccountChoice: React.FC<OxyEmailAccountChoiceProps> = ({
  accounts,
  onChoose,
  pendingId = null,
  disabled = false,
}) => {
  const theme = useTheme();
  const { oxyServices } = useOxy();
  const [hovered, setHovered] = useState<number | null>(null);

  /** The hairline under row `index`, hidden while either neighbour is hovered. */
  const divider = (index: number) =>
    index === accounts.length - 1 ? null : hovered === index || hovered === index + 1 ? (
      <View className="h-px mx-[8px]" />
    ) : (
      <View className="h-px mx-[8px] bg-border opacity-50" />
    );

  return (
    <View
      className="bg-fill-secondary rounded-[22px] overflow-hidden"
      testID="email-account-choice"
    >
      <ScrollView style={{ maxHeight: LIST_MAX_HEIGHT }} contentContainerStyle={{ padding: 8 }}>
        {accounts.map((account, index) => {
          const handle = getNormalizedUserHandle({ username: account.username });
          const name = account.displayName ?? (handle ? `@${handle}` : account.id);
          const busy = pendingId === account.id;
          return (
            <Fragment key={account.id}>
              <Pressable
                className={`flex-row items-center gap-[12px] rounded-[14px] p-[8px] ${hovered === index && !disabled ? 'bg-fill' : ''} ${disabled && !busy ? 'opacity-50' : ''}`}
                onPress={() => onChoose(account)}
                onHoverIn={() => setHovered(index)}
                onHoverOut={() => setHovered((value) => (value === index ? null : value))}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={name}
                accessibilityState={{ disabled, busy }}
                testID={`email-account-${account.id}`}
              >
                <View className="flex-1 min-w-0">
                  <Text
                    className="text-body text-text"
                    style={{ fontWeight: '500' }}
                    numberOfLines={1}
                  >
                    {name}
                  </Text>
                  {account.displayName && handle ? (
                    <Text className="text-bodySmall text-text-secondary" numberOfLines={1}>
                      @{handle}
                    </Text>
                  ) : null}
                </View>
                <View className="flex-row items-center gap-[8px] shrink-0">
                  <Avatar
                    source={
                      account.avatar
                        ? oxyServices.assets.publicUrl(account.avatar, 'thumb')
                        : undefined
                    }
                    variant="thumb"
                    name={name}
                    size={AVATAR_SIZE}
                  />
                  {busy ? (
                    <SpinnerIcon size={20} color={theme.colors.primary} />
                  ) : (
                    <RiArrowRightSLine size="sm" fill={theme.colors.textSecondary} />
                  )}
                </View>
              </Pressable>
              {divider(index)}
            </Fragment>
          );
        })}
      </ScrollView>
    </View>
  );
};
