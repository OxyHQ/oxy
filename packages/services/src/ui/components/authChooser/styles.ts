import { StyleSheet } from 'react-native';

/** High-contrast QR plate background — kept in sync with `OxyAuthChooser`'s QR colors. */
const QR_PLATE_BG = '#FFFFFF';

/**
 * Shared styles for `OxyAuthChooser`'s views. Extracted from `OxyAccountDialogScreen`
 * so both the Dialog-wrapped host and any bare host (e.g. a future
 * auth.oxy.so hub page) render identically without duplicating a StyleSheet.
 *
 * Content layout for account identity and authentication views. Bloom owns
 * grouped surfaces, row spacing and corner geometry.
 */
export const authChooserStyles = StyleSheet.create({
  accountSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingLeft: 16,
    paddingRight: 16,
    minHeight: 88,
  },
  accountIdentity: { flex: 1, minWidth: 0, gap: 3 },
  accountName: { fontSize: 20, fontWeight: '500' },
  accountAddress: { fontSize: 14 },
  menuGroup: { marginBottom: 12 },
  accountAvatar: { position: 'relative' },
  /**
   * The switch row's disclosure affordance — a filled circle around the chevron,
   * right-aligned to the same 12px row inset every other trailing element uses.
   */
  chevronCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Longhands: Bloom's web `Button` (`SubtleLink`) is a raw DOM <button>,
  // where `paddingVertical` is no CSS property and is silently dropped.
  footerLink: {
    alignSelf: 'center',
    paddingTop: 10,
    paddingBottom: 10,
    marginTop: 12,
  },
  linkText: {
    fontSize: 14,
    fontWeight: '600',
  },
  primaryButton: {
    width: '100%',
    borderRadius: 14,
    marginTop: 8,
  },
  centeredBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 24,
  },
  mutedText: {
    fontSize: 14,
    textAlign: 'center',
  },
  qrHeadline: {
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  qrPlate: {
    padding: 16,
    borderRadius: 16,
    backgroundColor: QR_PLATE_BG,
  },
  /**
   * The revealed "Having trouble?" alternatives — a tight stack of subordinate
   * text links. They share `footerLink`'s rhythm, so the stack itself only has
   * to stop them drifting apart.
   */
  troubleActions: {
    width: '100%',
    alignItems: 'center',
  },
  /**
   * The disclosure spans the content width, so the alternatives it reveals are
   * centred across the sheet rather than inside the trigger's own width. It
   * used to be `alignSelf: 'center'` — shrink-wrapped — and on Android that
   * both wrapped the trigger to "Having / trouble?" and squeezed the revealed
   * links into the same narrow column (OxyHQ/oxy#1375).
   */
  troubleDisclosure: {
    width: '100%',
    marginTop: 12,
  },
  /** The trigger itself stays a compact, centred affordance like the links. */
  troubleTrigger: {
    alignSelf: 'center',
  },
});
