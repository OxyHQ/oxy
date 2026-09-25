import { StyleSheet } from 'react-native';

/** High-contrast QR plate background — kept in sync with `OxyAuthChooser`'s QR colors. */
const QR_PLATE_BG = '#FFFFFF';

/**
 * Shared styles for `OxyAuthChooser`'s views. Extracted from `OxyAccountDialogScreen`
 * so both the Dialog-wrapped host and any bare host (e.g. a future
 * auth.oxy.so hub page) render identically without duplicating a StyleSheet.
 *
 * Only what NativeWind cannot express lives here: the animated collapse, the
 * fixed-contrast QR plate, per-account accent rings, and the small subordinate
 * text-link rhythm every view's fallback affordances share.
 */
export const authChooserStyles = StyleSheet.create({
  rows: {
    width: '100%',
    gap: 8,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  rowDisabled: {
    opacity: 0.6,
  },
  avatarRing: {
    borderRadius: 9999,
    borderWidth: 2,
    padding: 1,
  },
  rowMeta: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    fontSize: 15,
    fontWeight: '600',
  },
  rowHandle: {
    fontSize: 12.5,
    marginTop: 1,
  },
  /**
   * Animated-collapse container for the account switch list — the outer clip and
   * the inner measuring wrapper. Style-based (NOT NativeWind): the container
   * carries the animated `height`/`opacity` off a reanimated style, and the
   * measuring wrapper must stay className-free so its `onLayout` fires on RN-Web.
   */
  collapse: {
    overflow: 'hidden',
  },
  collapseMeasure: {
    width: '100%',
  },
  /**
   * The HERO block that opens the account menu: the current account's large
   * avatar, a greeting, and the "Manage your Oxy account" pill — centred and
   * deliberately chrome-free (no card, no grouped-section surface) so the
   * grouped cards below read as the menu proper. The account's email sits above
   * it in the Dialog's own nav bar, not here.
   */
  hero: {
    alignItems: 'center',
    paddingTop: 4,
    paddingBottom: 20,
    gap: 12,
  },
  /**
   * The current account's accent ring in the switch list, drawn OUTSIDE its
   * avatar as an overlay so it adds no width to the row — every avatar in the
   * list keeps the same footprint and the same content line. The 3px offset is
   * the ring's 2px stroke plus a 1px gap.
   */
  currentAvatarRing: {
    position: 'absolute',
    top: -3,
    left: -3,
    right: -3,
    bottom: -3,
    borderWidth: 2,
    borderRadius: 9999,
  },
  /**
   * The hero avatar's pressable wrapper — the "change your photo" entry point.
   * `relative` so the accent ring + camera badge (both absolutely positioned)
   * anchor to the avatar box.
   */
  heroAvatarPressable: {
    position: 'relative',
  },
  /** The hero avatar's accent ring — an overlay, like the row-level one. */
  heroAvatarRing: {
    position: 'absolute',
    top: -4,
    left: -4,
    right: -4,
    bottom: -4,
    borderWidth: 3,
    borderRadius: 9999,
  },
  /** Greeting + address stacked tight, centred (the hero's own 12px gap sits
   *  between this block and the avatar / manage pill, not between these lines). */
  heroNameBlock: {
    alignItems: 'center',
    gap: 2,
  },
  heroGreeting: {
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  /** The account address (`username@oxy.so` / `@handle`) under the greeting. */
  heroAddress: {
    fontSize: 14,
    textAlign: 'center',
  },
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
  footerLink: {
    alignSelf: 'center',
    paddingVertical: 10,
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
