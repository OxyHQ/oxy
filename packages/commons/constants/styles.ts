import { Platform, type ViewStyle } from 'react-native';

/**
 * Positioning shared by every floating UI cluster (the tabs layout's FAB and
 * the bottom action bar). On web the cluster is `position: fixed` so it stays
 * pinned while the content column scrolls; on native it is `position: absolute`
 * within the screen container. Typed as `ViewStyle` so the `position` literal
 * is validated instead of cast.
 */
export const floatingPosition: ViewStyle = Platform.select<ViewStyle>({
  // RN Web supports `position: fixed`; the RN ViewStyle union does not include it.
  web: { position: 'fixed' } as unknown as ViewStyle,
  default: { position: 'absolute' },
}) ?? { position: 'absolute' };

/**
 * A control that fills the width its parent offers.
 *
 * Bloom's `Button` is intrinsically sized, which is right for a button in a row
 * and wrong for the single call to action at the bottom of a form. The retired
 * `PrimaryButton`/`SecondaryButton` defaulted `fullWidth` to TRUE and expressed
 * it exactly this way, so passing this preserves their geometry rather than
 * approximating it.
 *
 * `alignSelf: 'stretch'` rather than the `width: '100%'` Bloom's migration note
 * suggests: stretch respects the parent's padding, where a 100% width measures
 * against the content box and overflows a padded column.
 */
export const fullWidthControl: ViewStyle = { alignSelf: 'stretch' };
