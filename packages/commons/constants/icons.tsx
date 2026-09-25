/**
 * Every glyph Commons draws, as a Bloom icon component.
 *
 * 1. **The imports below are the required shape.** Each glyph comes from its own
 *    `@oxy.so/bloom/icons/Ri*` subpath, never from `@oxy.so/bloom/icons` —
 *    Metro does not tree-shake, so naming one glyph through that barrel bundles
 *    all of them. Collecting the subpath imports here keeps that rule in one
 *    place.
 * 2. **Several icons are DATA.** `lib/civic/reputation-activity.ts` maps a civic
 *    action type to a glyph and the settings screens build row tables; those
 *    need a value to put in a record, and a component reference is that value.
 *
 * The names are the app's, not Remix's (`Icons.validation`, not
 * `RiHammerLine`), so a better glyph for one of the approximations below
 * changes this file and nothing else.
 *
 * ## Approximations
 *
 * Bloom's Remix set has no exact match for these (`@expo/vector-icons` stays out
 * of the app: one glyph ships its whole 1.3 MB font):
 *
 * | wanted             | now                    | how close |
 * | ------------------ | ---------------------- | --------- |
 * | `fingerprint`      | `RiShieldUserLine`     | POOR — "a verified human" instead of a fingerprint. The personhood and credential screens are the ones that read less precisely. |
 * | `scale-balance`    | `RiHammerLine`         | POOR — the scales of justice became the gavel, so validation and its verdict now share a glyph. |
 * | `gavel`            | `RiHammerLine`         | good |
 * | `certificate`      | `RiMedalLine`          | good |
 * | `server-network`   | `RiNodeTree`           | good — the screen is literally about a node |
 * | `cellphone-key`    | `RiSmartphoneLine`     | fair — loses the key |
 * | `cloud-off-outline`| `RiWifiLine`           | fair — says "offline" a different way |
 * | `circle-small`     | `RiCheckboxBlankCircleLine` | fair — a ring rather than a filled dot |
 *
 * The first two want a real fix: Remix Icon HAS a fingerprint and scales
 * upstream, and Bloom vendors a subset. Add them to Bloom, release, and point
 * the two entries here at the new names.
 */
import type { ComponentProps } from 'react';

import { RiArrowGoBackLine } from '@oxy.so/bloom/icons/RiArrowGoBackLine';
import { RiCalendarCloseLine } from '@oxy.so/bloom/icons/RiCalendarCloseLine';
import { RiCalendarEventLine } from '@oxy.so/bloom/icons/RiCalendarEventLine';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { RiForbidLine } from '@oxy.so/bloom/icons/RiForbidLine';
import { RiHistoryLine } from '@oxy.so/bloom/icons/RiHistoryLine';
import { RiInfinityLine } from '@oxy.so/bloom/icons/RiInfinityLine';
import { RiInformationLine } from '@oxy.so/bloom/icons/RiInformationLine';
import { RiLayoutGridLine } from '@oxy.so/bloom/icons/RiLayoutGridLine';
import { RiLoopRightLine } from '@oxy.so/bloom/icons/RiLoopRightLine';
import { RiPencilLine } from '@oxy.so/bloom/icons/RiPencilLine';
import { RiShareLine } from '@oxy.so/bloom/icons/RiShareLine';
import { RiSortDesc } from '@oxy.so/bloom/icons/RiSortDesc';
import { RiTerminalBoxLine } from '@oxy.so/bloom/icons/RiTerminalBoxLine';
import { RiUserSearchLine } from '@oxy.so/bloom/icons/RiUserSearchLine';
import { RiAlertFill } from '@oxy.so/bloom/icons/RiAlertFill';
import { RiAlertLine } from '@oxy.so/bloom/icons/RiAlertLine';
import { RiArrowLeftSLine } from '@oxy.so/bloom/icons/RiArrowLeftSLine';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiCheckboxBlankCircleLine } from '@oxy.so/bloom/icons/RiCheckboxBlankCircleLine';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiEyeOffLine } from '@oxy.so/bloom/icons/RiEyeOffLine';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { RiFilePaper2Line } from '@oxy.so/bloom/icons/RiFilePaper2Line';
import { RiFileTextLine } from '@oxy.so/bloom/icons/RiFileTextLine';
import { RiFlagLine } from '@oxy.so/bloom/icons/RiFlagLine';
import { RiFlashlightLine } from '@oxy.so/bloom/icons/RiFlashlightLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiHammerLine } from '@oxy.so/bloom/icons/RiHammerLine';
import { RiKey2Line } from '@oxy.so/bloom/icons/RiKey2Line';
import { RiLinkM } from '@oxy.so/bloom/icons/RiLinkM';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { RiLogoutBoxRLine } from '@oxy.so/bloom/icons/RiLogoutBoxRLine';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';
import { RiMedalLine } from '@oxy.so/bloom/icons/RiMedalLine';
import { RiNodeTree } from '@oxy.so/bloom/icons/RiNodeTree';
import { RiQrCodeLine } from '@oxy.so/bloom/icons/RiQrCodeLine';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiShakeHandsLine } from '@oxy.so/bloom/icons/RiShakeHandsLine';
import { RiShieldCheckLine } from '@oxy.so/bloom/icons/RiShieldCheckLine';
import { RiShieldLine } from '@oxy.so/bloom/icons/RiShieldLine';
import { RiShieldStarFill } from '@oxy.so/bloom/icons/RiShieldStarFill';
import { RiShieldUserLine } from '@oxy.so/bloom/icons/RiShieldUserLine';
import { RiSmartphoneLine } from '@oxy.so/bloom/icons/RiSmartphoneLine';
import { RiStarLine } from '@oxy.so/bloom/icons/RiStarLine';
import { RiTeamLine } from '@oxy.so/bloom/icons/RiTeamLine';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';
import { RiTimerLine } from '@oxy.so/bloom/icons/RiTimerLine';
import { RiUserFollowLine } from '@oxy.so/bloom/icons/RiUserFollowLine';
import { RiUserHeartLine } from '@oxy.so/bloom/icons/RiUserHeartLine';
import { RiVerifiedBadgeFill } from '@oxy.so/bloom/icons/RiVerifiedBadgeFill';
import { RiVerifiedBadgeLine } from '@oxy.so/bloom/icons/RiVerifiedBadgeLine';
import { RiWifiLine } from '@oxy.so/bloom/icons/RiWifiLine';

/** The props every Bloom glyph takes, so {@link AppIcon} can forward them all. */
type BloomIconProps = ComponentProps<typeof RiAlertFill>;

/** Commons' glyph vocabulary. Values are Bloom icon components. */
export const Icons = {
  // Navigation and chrome
  back: RiArrowLeftSLine,
  forward: RiArrowRightSLine,
  close: RiCloseLine,
  refresh: RiRefreshLine,
  settings: RiSettings3Line,
  scan: RiQrCodeLine,
  flash: RiFlashlightLine,

  // Status
  alert: RiAlertLine,
  alertStrong: RiAlertFill,
  check: RiCheckLine,
  checkCircle: RiCheckboxCircleLine,
  closeCircle: RiCloseCircleLine,
  offline: RiWifiLine,
  pending: RiTimeLine,
  expired: RiTimerLine,
  bullet: RiCheckboxBlankCircleLine,

  // Identity and keys
  key: RiKey2Line,
  lock: RiLockLine,
  hidden: RiEyeOffLine,
  device: RiSmartphoneLine,
  signOut: RiLogoutBoxRLine,
  /** Proof of personhood. See the approximation table above. */
  personhood: RiShieldUserLine,
  verified: RiVerifiedBadgeFill,
  verifiedOutline: RiVerifiedBadgeLine,
  shield: RiShieldLine,
  shieldCheck: RiShieldCheckLine,
  shieldStar: RiShieldStarFill,

  // People
  person: RiUserLine,
  people: RiTeamLine,
  community: RiGroupLine,
  vouched: RiUserFollowLine,
  endorsed: RiUserHeartLine,
  handshake: RiShakeHandsLine,

  // Documents and data
  credential: RiMedalLine,
  document: RiFileTextLine,
  sealedDocument: RiFilePaper2Line,
  copy: RiFileCopyLine,
  delete: RiDeleteBinLine,
  node: RiNodeTree,
  link: RiLinkM,
  web: RiGlobalLine,
  place: RiMapPin2Line,
  report: RiFlagLine,
  star: RiStarLine,
  /** Validation / a verdict. See the approximation table above. */
  validation: RiHammerLine,

  // Diagnostics, history and system state
  info: RiInformationLine,
  error: RiErrorWarningLine,
  blocked: RiForbidLine,
  history: RiHistoryLine,
  sync: RiLoopRightLine,
  sort: RiSortDesc,
  unlimited: RiInfinityLine,
  grid: RiLayoutGridLine,
  terminal: RiTerminalBoxLine,
  share: RiShareLine,
  edit: RiPencilLine,
  undo: RiArrowGoBackLine,
  search: RiUserSearchLine,
  scheduled: RiCalendarEventLine,
  unscheduled: RiCalendarCloseLine,
} as const;

/** A key of {@link Icons} — the app's own icon vocabulary. */
export type IconName = keyof typeof Icons;

/**
 * A glyph chosen at RUNTIME, by name.
 *
 * Most call sites should write the component directly — `<Icons.key size="md" />`
 * — because the glyph is known when the screen is written. This exists for the
 * places where it is not: a settings row table, a civic action's metadata, a
 * status map keyed by a credential's state. Those hold an {@link IconName}
 * string because a record of data is the right shape for them, and this turns
 * the string back into the component.
 *
 * It takes Bloom's own icon props (`size` rung, `width`/`height`, `fill`,
 * `style`), so a caller is never choosing between two vocabularies.
 */
export function AppIcon({ name, ...props }: { name: IconName } & BloomIconProps) {
  const Glyph = Icons[name];
  return <Glyph {...props} />;
}
