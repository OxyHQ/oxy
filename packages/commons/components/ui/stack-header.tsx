import React from 'react';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { GlyphButton } from '@oxy.so/bloom/button';
import { Icons } from '@/constants/icons';

interface StackHeaderProps {
  title: string;
  subtitle?: string;
  /** Show a leading back chevron when provided. */
  onBack?: () => void;
  /** Show a trailing close (✕) affordance when provided (modal-style screens). */
  onClose?: () => void;
  backAccessibilityLabel?: string;
  closeAccessibilityLabel?: string;
}

/**
 * The header for pushed / modal Commons screens — Bloom's `PageHeader`, with
 * this app's close affordance in its actions slot.
 *
 * ## Why `bar` + `inline`, and not the chrome slot
 *
 * Bloom's own model is `Screen header={<PageHeader />}`: floating chrome that
 * content passes under, with `Screen` reserving its measured footprint. This
 * header is NOT mounted that way, and the reason is where its 29 call sites
 * live — fifteen directly inside the app's `Screen` content column, five inside
 * a `<View>` that pads them, five inside `KeyboardAwareScrollViewWrapper` (which
 * is not a `Screen` at all) and one nested deeper. Moving all of them into a
 * chrome slot is a layout change on twenty screens, and it is the kind that
 * either looks right or leaves content under the header — which cannot be
 * decided from a bundle.
 *
 * So `presentation="bar"` with `placement="inline"`: Bloom's documented in-FLOW
 * arrangement, where "the header is a sibling ABOVE the content, in a column. It
 * occupies layout, so nothing passes under it and nothing needs padding." Every
 * call site keeps its position and Bloom draws the header. Moving to the chrome
 * slot afterwards is then a per-screen change with a device in front of you.
 *
 * ## What it stops drawing by hand
 *
 * A back chevron and a close ✕ as bare `TouchableOpacity`s with 40pt boxes and a
 * −10 margin, a 28/700/−0.5 title and a 15/21 subtitle. The title is now a
 * heading that announces as one; the back button is `PageHeader`'s own; the
 * close is a `GlyphButton`, which Bloom names as the neutral transparent icon
 * button for exactly this (a `ghost` Button would tint it with the accent).
 *
 * VISUAL DELTA: the title takes `PageHeader`'s bar step rather than the 28pt
 * large-title rhythm this app had, so 29 screens get a more compact heading.
 */
export function StackHeader({
  title,
  subtitle,
  onBack,
  onClose,
  backAccessibilityLabel,
  closeAccessibilityLabel,
}: StackHeaderProps) {
  return (
    <PageHeader
      presentation="bar"
      placement="inline"
      border="none"
      title={title}
      subtitle={subtitle}
      onBack={onBack}
      backLabel={backAccessibilityLabel}
      actions={
        onClose ? (
          <GlyphButton
            icon={Icons.close}
            onPress={onClose}
            // GlyphButton REQUIRES a name: it draws only a glyph, so without one
            // it announces as nothing. Two of the three callers pass their own.
            accessibilityLabel={closeAccessibilityLabel ?? 'Close'}
          />
        ) : undefined
      }
    />
  );
}
