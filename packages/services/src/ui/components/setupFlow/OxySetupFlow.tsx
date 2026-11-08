/**
 * A platform's setup, in the SDK sign-in's own frame: the host's steps and the
 * SDK's sign-in (`oxySignInStep`) one after another on one card, as macOS's
 * Setup Assistant walks Welcome → Apple Account → … → Done (oxy ADR 0064,
 * OxyOS ADR 0020).
 *
 * Controlled and presentational: the host owns which steps apply, which one is
 * current and what every action does; this draws them.
 *
 *   step     the sign-in's shell (`OxyAuthScreen`): the step's icon or the Oxy
 *            mark (56), its title (48/800) and description (18), its content,
 *            blocks 24 apart, at most 448 wide. A step with an `aside` is the
 *            split card from `md` (`OxyAuthSplit`), asking its surface for 880
 *            as the sign-in's QR side does. A step without a title is drawn as
 *            its content brings it (the SDK sign-in brings its own screens).
 *   motion   a step change is Bloom's `ScreenTransition` (forward from the
 *            right, back from the left; a cross-fade on the web), clipped to
 *            the card; nothing moves under reduced motion
 *   progress quiet, above the footer: decorative dots and "Step 2 of 5"
 *   footer   Back leading (plain), then the secondary action and the primary
 *            (the solid default action) trailing — Tab order is visual order
 *
 * Accessibility: on a step change focus moves to the new step's title, or
 * stays with its content when the step says so (`initialFocus: 'content'`: a
 * field of its own takes it), and the change is said politely ("Create a PIN,
 * step 3 of 5"). The dots are hidden from assistive technology; the count line
 * and the announcement say where the step sits.
 */

import type React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, Text as RNText } from 'react-native';
import { View } from 'react-native-css/components';
import { Button } from '@oxy.so/bloom/button';
import { CarouselDots } from '@oxy.so/bloom/carousel';
import { useItemAccessibilityFocus, usePrefersReducedMotion } from '@oxy.so/bloom/hooks';
import { ScreenTransition } from '@oxy.so/bloom/motion';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { useI18n } from '../../hooks/useI18n';
import { SurfaceFrameWidthContext, useSurfaceFrameWidth } from '../../hooks/useSurfaceFrameWidth';
import { OxyAuthScreen, OxyAuthScreenHeader, OxyAuthSplit } from '../signIn/OxyAuthScreen';

/** The split card's width, as the sign-in asks it for its QR side. */
const SPLIT_WIDTH = 880;

/** A footer action of a step. */
export interface OxySetupAction {
  label: string;
  onPress: () => void;
  testID?: string;
}

/** The step's primary action: the default one, solid. */
export interface OxySetupPrimaryAction extends OxySetupAction {
  /** Not available yet (a PIN not typed twice). */
  disabled?: boolean;
  /** Working: Bloom's spinner, presses refused, said busy; Back and the secondary wait with it. */
  busy?: boolean;
}

/** One step of a setup. */
export interface OxySetupStep {
  /** Stable: focus, the announcement and the transition key on it. */
  id: string;
  /** The step's one heading. Omit for content that brings its own (the SDK sign-in). */
  title?: string;
  description?: React.ReactNode;
  /** Drawn in place of the Oxy mark above the title (the host's own step icon), at most 56 tall. */
  icon?: React.ReactNode;
  /** The step's body. */
  content: React.ReactNode;
  /** From `md`, the split card's right column (as the sign-in's QR side). */
  aside?: React.ReactNode;
  /**
   * Where focus goes when the step becomes current: its title (`'heading'`, the
   * default with a title), or left to its content (`'content'`, the default
   * without one) — a step whose field takes focus itself (`autoFocus`).
   */
  initialFocus?: 'heading' | 'content';
  primary?: OxySetupPrimaryAction;
  /** "Not Now", "Set Up Later". */
  secondary?: OxySetupAction;
}

export interface OxySetupFlowProps {
  /** The accessible name of the whole setup ("Set up your account"). */
  label: string;
  /** In order; the host decides which apply. */
  steps: readonly OxySetupStep[];
  /** The current step's `id` (controlled). */
  current: string;
  /** Back is offered on the current step only when this is given. */
  onBack?: () => void;
  /** Default: the SDK's own "Back". */
  /**
   * The language the flow's own words speak (its progress, its announcements, the default Back),
   * a BCP 47 tag. A platform's setup passes its system's: the flow then stays in it after the
   * sign-in, when the runtime turns to the account's own language. Default: the runtime's.
   */
  locale?: string;
  backLabel?: string;
  /** "Step 2 of 5" and the dots. Default `true`. */
  showProgress?: boolean;
  /**
   * The card width (px) the current step asks, as `OxySurfaceFrame` reports it:
   * 880 for a split step (the sign-in's, with the QR, from `md`), `null` for the
   * card's own. A surface around the flow (`OxySurfaceFrame`, the account
   * dialog) is asked too.
   */
  onMaxWidthChange?: (maxWidth: number | null) => void;
}

/** What one step change owes: the direction it travelled and what to say and focus. */
interface StepChange {
  id: string;
  /** 0 until the first change: appearing is not a change. */
  count: number;
  direction: 'forward' | 'backward';
  announcement: string;
  focusHeading: boolean;
}

/** Asks the surface for the split card's width while mounted. */
const SplitWidth: React.FC = () => {
  useSurfaceFrameWidth(SPLIT_WIDTH);
  return null;
};

const StepBody: React.FC<{
  step: OxySetupStep;
  titleRef: React.Ref<React.ComponentRef<typeof RNText>>;
}> = ({ step, titleRef }) => {
  const header = step.title ? (
    <OxyAuthScreenHeader
      title={step.title}
      description={step.description}
      icon={step.icon}
      titleRef={titleRef}
    />
  ) : null;
  if (step.aside != null) {
    return (
      <>
        <SplitWidth />
        <OxyAuthSplit bare aside={step.aside}>
          <OxyAuthScreen className="md:max-w-none">
            {header}
            {step.content}
          </OxyAuthScreen>
        </OxyAuthSplit>
      </>
    );
  }
  if (!header) return <>{step.content}</>;
  return (
    <OxyAuthScreen>
      {header}
      {step.content}
    </OxyAuthScreen>
  );
};

/** Off screen, still read: the web's polite announcement. */
const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  overflow: 'hidden',
  opacity: 0,
} as const;

/** Says `text` once, politely, on a platform with an announcement API (not the web). */
function announce(text: string): void {
  if (Platform.OS === 'ios') {
    // iOS has no live regions; queued, the title the focus move reads goes first.
    AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: true });
    return;
  }
  AccessibilityInfo.announceForAccessibility(text);
}

export const OxySetupFlow: React.FC<OxySetupFlowProps> = ({
  label,
  steps,
  current,
  onBack,
  backLabel,
  locale,
  showProgress = true,
  onMaxWidthChange,
}) => {
  const { t } = useI18n(locale);
  const theme = useTheme();
  const reducedMotion = usePrefersReducedMotion();
  const index = steps.findIndex((candidate) => candidate.id === current);
  const step = index === -1 ? undefined : steps[index];
  const total = steps.length;
  const focusHeading = step?.title ? (step.initialFocus ?? 'heading') === 'heading' : false;
  const announcement =
    step?.title != null && step.title !== ''
      ? t('common.stepAnnouncement', { title: step.title, step: index + 1, total })
      : t('common.stepOf', { step: index + 1, total });

  // A step change, derived during render: which way it went, and what it owes.
  const [change, setChange] = useState<StepChange>({
    id: current,
    count: 0,
    direction: 'forward',
    announcement,
    focusHeading,
  });
  if (change.id !== current) {
    const from = steps.findIndex((candidate) => candidate.id === change.id);
    setChange({
      id: current,
      count: change.count + 1,
      direction: from !== -1 && index < from ? 'backward' : 'forward',
      announcement,
      focusHeading,
    });
  }

  // The width the current step asks (the sign-in's split card, a step's aside),
  // handed to the host and to any surface around the flow.
  const [askedWidth, setAskedWidth] = useState<number | null>(null);
  useSurfaceFrameWidth(askedWidth);
  useLayoutEffect(() => {
    if (!onMaxWidthChange) return;
    onMaxWidthChange(askedWidth);
    return () => onMaxWidthChange(null);
  }, [onMaxWidthChange, askedWidth]);

  // Screen-reader focus to the new title on native (Bloom's, which waits for
  // the view to be laid out); the browser's focus on the web, below.
  const focusTitle = useItemAccessibilityFocus(focusHeading && step ? step.id : null);
  const webTitle = useRef<React.ComponentRef<typeof RNText> | null>(null);
  const titleRef = (view: React.ComponentRef<typeof RNText> | null) => {
    webTitle.current = view;
    if (step) focusTitle(step.id, view);
  };

  useEffect(() => {
    if (change.count === 0) return;
    if (Platform.OS === 'web') {
      // The pressed button may be gone with its step: focus goes to the new title.
      if (change.focusHeading) webTitle.current?.focus?.();
      return;
    }
    announce(change.announcement);
  }, [change]);

  if (!step) return null;

  const busy = step.primary?.busy === true;
  const wide = askedWidth !== null;
  const body = <StepBody step={step} titleRef={titleRef} />;

  return (
    // A labelled region: the setup is a place a reader can name and jump to.
    <View
      role="region"
      accessibilityLabel={label}
      className={`w-full self-center gap-6 max-w-[448px] ${wide ? 'md:max-w-[880px]' : ''}`}
    >
      <SurfaceFrameWidthContext.Provider value={setAskedWidth}>
        {/* Clipped, so a step slides in within the card; the 4px bleed keeps
            the content's focus rings. */}
        <View className="-m-1 overflow-hidden p-1">
          {reducedMotion ? (
            <View key={step.id} testID="oxy-setup-step">
              {body}
            </View>
          ) : (
            <ScreenTransition key={step.id} direction={change.direction} enabledWeb>
              {body}
            </ScreenTransition>
          )}
        </View>
      </SurfaceFrameWidthContext.Provider>

      {showProgress && total > 1 ? (
        <View className="items-center gap-2">
          <CarouselDots count={total} index={index} testID="oxy-setup-dots" />
          <Text
            variant="caption-1-medium"
            style={{ color: theme.colors.textSecondary }}
            testID="oxy-setup-progress"
          >
            {t('common.stepOf', { step: index + 1, total })}
          </Text>
        </View>
      ) : null}

      {onBack || step.secondary || step.primary ? (
        <View className="w-full flex-row items-center gap-3">
          {onBack ? (
            <Button
              appearance="plain"
              tone="neutral"
              size="lg"
              onPress={onBack}
              disabled={busy}
              testID="oxy-setup-back"
            >
              {backLabel ?? t('common.actions.back')}
            </Button>
          ) : null}
          <View className="flex-1" />
          {step.secondary ? (
            <Button
              appearance="subtle"
              tone="neutral"
              size="lg"
              onPress={step.secondary.onPress}
              disabled={busy}
              testID={step.secondary.testID ?? 'oxy-setup-secondary'}
            >
              {step.secondary.label}
            </Button>
          ) : null}
          {step.primary ? (
            <Button
              appearance="solid"
              tone="action"
              size="lg"
              onPress={step.primary.onPress}
              disabled={step.primary.disabled}
              loading={busy}
              testID={step.primary.testID ?? 'oxy-setup-primary'}
            >
              {step.primary.label}
            </Button>
          ) : null}
        </View>
      ) : null}

      {Platform.OS === 'web' ? (
        <RNText aria-live="polite" style={VISUALLY_HIDDEN} testID="oxy-setup-announcement">
          {change.count > 0 ? change.announcement : ''}
        </RNText>
      ) : null}
    </View>
  );
};
