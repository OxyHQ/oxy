/**
 * Back face of the Oxy ID card — the public-key face, laid out like the front so
 * both sides read as one document: an issuer header, the full public key in a
 * readable engraved block, and a footer with the issue date + self-custody note.
 */

import { StyleSheet, Text, View } from 'react-native';
import { Fonts } from '@/constants/theme';
import { HolographicLogo } from './holographic-logo';
import { EMBLEM_CLEARANCE } from './emblem';
import { useTranslation } from '@/lib/i18n';

interface BackSideProps {
  publicKey?: string;
  displayName?: string;
  accountCreated?: string;
}

const formatPublicKey = (key?: string) => {
  if (!key) return 'N/A';
  const cleanKey = key.replace(/^0x/i, '');
  return cleanKey.match(/.{1,8}/g)?.join(' ') || cleanKey;
};

const formatDate = (dateString?: string) => {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return 'N/A';
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
};

export const BackSide: React.FC<BackSideProps> = ({ publicKey, displayName, accountCreated }) => {
  const { t } = useTranslation();
  return (
    <View style={styles.container}>
      {/* Header — mirrors the front. */}
      <View style={styles.header}>
        <HolographicLogo size={20} />
        <Text style={styles.docType}>PUBLIC KEY</Text>
      </View>

      {/* The public key, engraved and readable. */}
      <View style={styles.keySection}>
        <Text style={styles.keyLabel}>PUBLIC KEY</Text>
        <Text style={styles.keyValue} selectable>
          {formatPublicKey(publicKey)}
        </Text>
        {displayName ? (
          <>
            <Text style={[styles.keyLabel, styles.holderLabel]}>HOLDER</Text>
            <Text style={styles.holderValue} numberOfLines={1}>
              {displayName}
            </Text>
          </>
        ) : null}
      </View>

      {/* Footer — issue date + self-custody note. */}
      <View style={styles.footer}>
        <View style={styles.infoRow}>
          <Text style={styles.footerStrong}>ISSUED</Text>
          <Text style={styles.footerStrong}>{formatDate(accountCreated)}</Text>
        </View>
        <Text style={styles.footerNote}>{t('civic.id.card.backFooterNote')}</Text>
      </View>
    </View>
  );
};

/** The face's own padding; the footer's left inset is measured from it. */
const FACE_PADDING = 18;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: FACE_PADDING,
    justifyContent: 'space-between',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.18)',
    paddingBottom: 6,
  },
  docType: {
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1.2,
    color: '#6E6E73',
  },
  keySection: {
    flex: 1,
    justifyContent: 'center',
  },
  keyLabel: {
    color: '#6E6E73',
    fontSize: 8.5,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    fontWeight: '600',
    marginBottom: 8,
  },
  holderLabel: {
    marginTop: 16,
    marginBottom: 2,
  },
  keyValue: {
    color: '#1C1C1E',
    fontFamily: Fonts?.mono,
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: 0.5,
    lineHeight: 18,
  },
  holderValue: {
    color: '#1C1C1E',
    fontSize: 15,
    fontWeight: '700',
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.18)',
    paddingTop: 8,
    gap: 3,
    // The hologram's emblem shows in this face's bottom-LEFT corner (the
    // hologram does not flip with the card). Without this inset the note wrapped
    // under it ("SELF-CUSTODY · NO PASSWORD · YOU HOLD THE KEY", Pixel 8a). The
    // note may wrap; it wraps beside the mark, never under it.
    paddingLeft: EMBLEM_CLEARANCE - FACE_PADDING,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerStrong: {
    color: '#2B2B2E',
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  footerNote: {
    color: '#6E6E73',
    fontSize: 9,
    letterSpacing: 0.3,
  },
});
