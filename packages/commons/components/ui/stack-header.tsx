import { createContext, useContext } from 'react';
import { StyleSheet, View } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { GlyphButton } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { Icons } from '@/constants/icons';

export interface StackHeaderProps {
  title: string;
  subtitle?: string;
  /** Show a leading back chevron when provided. */
  onBack?: () => void;
  /** Show a trailing close (✕) affordance when provided (modal-style screens). */
  onClose?: () => void;
  backAccessibilityLabel?: string;
  closeAccessibilityLabel?: string;
}

/** Scroll distance after which the large title has gone and the header shows its own. */
export const PAGE_TITLE_REVEAL_OFFSET = 44;

function closeAction({
  onClose,
  closeAccessibilityLabel,
}: Pick<StackHeaderProps, 'onClose' | 'closeAccessibilityLabel'>) {
  return onClose ? (
    <GlyphButton
      icon={Icons.close}
      onPress={onClose}
      // GlyphButton REQUIRES a name: it draws only a glyph, so without one it
      // announces as nothing.
      accessibilityLabel={closeAccessibilityLabel ?? 'Close'}
    />
  ) : undefined;
}

/**
 * The page's own title, at the top of its content: a real heading, not the
 * body-size line a bar header draws. Paired with {@link ScreenHeader}, which
 * shows the same title once this one has scrolled away.
 */
export function PageTitle({ title, subtitle }: Pick<StackHeaderProps, 'title' | 'subtitle'>) {
  const { colors } = useTheme();
  return (
    <View style={styles.pageTitle}>
      <Text variant="display-4-semibold" accessibilityRole="header" style={{ color: colors.text }}>
        {title}
      </Text>
      {subtitle ? (
        <Text variant="headline-regular" style={{ color: colors.textSecondary }}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The chrome of a Commons `Screen`: Bloom's floating `PageHeader` in the
 * screen's header slot. It owns the top safe area, so content scrolls UNDER
 * its scrim and never under the status bar; its title fades in only once the
 * page's own large title ({@link PageTitle}) has scrolled away. With no
 * `title` it is the scrim alone (the ID tab, which has no page title).
 */
export function ScreenHeader(props: Partial<StackHeaderProps>) {
  const { title, onBack, backAccessibilityLabel } = props;
  return (
    <PageHeader
      presentation="floating"
      title={title}
      titleReveal="onScroll"
      titleRevealOffset={PAGE_TITLE_REVEAL_OFFSET}
      onBack={onBack}
      backLabel={backAccessibilityLabel}
      actions={closeAction(props)}
    />
  );
}

/** True inside a Commons `Screen`, whose header slot already owns the top safe area. */
export const InsideScreenContext = createContext(false);

/**
 * The header of a pushed / modal Commons screen.
 *
 * As the FIRST child of a Commons `Screen` it is lifted out of the content:
 * the screen renders its back/close row and scrim as {@link ScreenHeader} and
 * its title as {@link PageTitle} at the top of the content. Anywhere else (a
 * `KeyboardAwareScrollViewWrapper`, which pads the top safe area itself) it
 * renders the same two parts inline, WITHOUT adding the safe area again: the
 * doubled inset is what put ~300px of air above a small Settings title.
 */
export function StackHeader(props: StackHeaderProps) {
  const insideScreen = useContext(InsideScreenContext);
  const hasControls = Boolean(props.onBack || props.onClose);
  return (
    <View>
      {hasControls ? (
        <PageHeader
          presentation="navigation"
          safeArea={false}
          onBack={props.onBack}
          backLabel={props.backAccessibilityLabel}
          actions={closeAction(props)}
          style={insideScreen ? undefined : styles.inlineControls}
        />
      ) : null}
      <PageTitle title={props.title} subtitle={props.subtitle} />
    </View>
  );
}

const styles = StyleSheet.create({
  pageTitle: { gap: 4, paddingBottom: 8 },
  inlineControls: { marginHorizontal: -8 },
});
