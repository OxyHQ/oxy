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
import { Pressable, ScrollView, View } from 'react-native';
import { Avatar } from '@oxy.so/bloom/avatar';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { SpinnerIcon } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import type { EmailSignInAccountOption } from '@oxy.so/contracts';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { useOxy } from '../../context/oxyRuntimeContext';
import { createTokenStyles } from '@oxy.so/bloom/theme';

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
  const styles = useStyles();
  const theme = useTheme();
  const { oxyServices } = useOxy();
  const [hovered, setHovered] = useState<number | null>(null);

  /** The hairline under row `index`, hidden while either neighbour is hovered. */
  const divider = (index: number) =>
    index === accounts.length - 1 ? null : hovered === index || hovered === index + 1 ? (
      <View style={styles.container} />
    ) : (
      <View style={styles.surface} />
    );

  return (
    <View style={styles.surface2} testID="email-account-choice">
      <ScrollView style={{ maxHeight: LIST_MAX_HEIGHT }} contentContainerStyle={{ padding: 8 }}>
        {accounts.map((account, index) => {
          const handle = getNormalizedUserHandle({ username: account.username });
          const name = account.displayName ?? (handle ? `@${handle}` : account.id);
          const busy = pendingId === account.id;
          return (
            <Fragment key={account.id}>
              <Pressable
                style={[
                  styles.account,
                  hovered === index && !disabled ? styles.accountHovered : null,
                  disabled && !busy ? styles.accountDisabled : null,
                ]}
                onPress={() => onChoose(account)}
                onHoverIn={() => setHovered(index)}
                onHoverOut={() => setHovered((value) => (value === index ? null : value))}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={name}
                accessibilityState={{ disabled, busy }}
                testID={`email-account-${account.id}`}
              >
                <View style={styles.container2}>
                  <Text style={[styles.text, { fontWeight: '500' }]} numberOfLines={1}>
                    {name}
                  </Text>
                  {account.displayName && handle ? (
                    <Text style={styles.mutedText} numberOfLines={1}>
                      @{handle}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.row}>
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

const useStyles = createTokenStyles((t) => ({
  account: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, padding: 8 },
  accountHovered: { backgroundColor: t.card },
  accountDisabled: { opacity: 0.5 },
  container: { marginHorizontal: 8, height: 1 },
  surface: { marginHorizontal: 8, height: 1, backgroundColor: t.border, opacity: 0.5 },
  surface2: { overflow: 'hidden', borderRadius: 22, backgroundColor: t.muted },
  container2: { minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  text: { color: t.foreground, lineHeight: 22, fontWeight: 400 },
  mutedText: { color: t.mutedForeground, lineHeight: 18, fontWeight: 400 },
  row: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
}));
