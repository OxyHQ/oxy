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
 * The header for pushed / modal Commons screens — Bloom's `PageHeader`, with a
 * `GlyphButton` close (Bloom's neutral transparent icon button; a `ghost`
 * Button would tint it with the accent) in its actions slot.
 *
 * `presentation="bar"` + `placement="inline"` is Bloom's in-FLOW arrangement:
 * the header is a sibling above the content, so nothing passes under it. Call
 * sites mount it inside the content column (and inside
 * `KeyboardAwareScrollViewWrapper`, which is not a `Screen`), so moving it to
 * `Screen`'s chrome slot is a per-screen layout change to judge on a device.
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
            // it announces as nothing.
            accessibilityLabel={closeAccessibilityLabel ?? 'Close'}
          />
        ) : undefined
      }
    />
  );
}
