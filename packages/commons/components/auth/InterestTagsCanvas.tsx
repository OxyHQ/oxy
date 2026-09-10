import {
  Canvas,
  Group,
  RoundedRect,
  Text as SkiaText,
  matchFont,
  useFont,
} from '@shopify/react-native-skia';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, Platform, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  makeMutable,
  SensorType,
  useAnimatedSensor,
  useDerivedValue,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import {
  hitTestWoodenPill,
  stepWoodenPills,
  type WoodenPillBody,
} from './woodenPillsPhysics';
import { ICON_GLYPHS, INTEREST_TAGS } from '@/constants/interestTags';

const iconFontFile = require('@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/MaterialCommunityIcons.ttf');

const TAG_HEIGHT = 44;
const TAG_RADIUS = 22;
const GAP = 2;
// Tag layout: [12 left padding][16 icon][4 gap][label][16 right padding]
const ICON_AREA = 32;
const H_PADDING = 16;
const MIN_TAG_WIDTH = 80;
const LABEL_FONT_SIZE = 14;
const ICON_FONT_SIZE = 16;
const SPAWN_STAGGER = 60;
// Upward nudge on tap, so selecting reads as a physical poke.
const TAP_IMPULSE_Y = -260;
const ESCAPE_MARGIN = 300;
const MAX_APPARENT_GRAVITY = 1.8;
const MAX_SHAKE_GRAVITY = 0.95;
const ACCELEROMETER_RESPONSE_MS = 25;
const EARTH_GRAVITY = 9.80665;
const FLAT_NEUTRAL_DOWN_GRAVITY = 0.38;
const HAPTIC_IMPACT_SPEED = 520;
const FIRM_HAPTIC_IMPACT_SPEED = 1200;
const HAPTIC_COOLDOWN_MS = 100;
const WORLD_SLEEP_SPEED = 300;
const WORLD_SLEEP_DELAY_MS = 240;
const QUIET_INPUT_DELTA = 0.025;
const WAKE_INPUT_DELTA = 0.035;
const QUIET_SHAKE_GRAVITY = 0.12;
const WAKE_SHAKE_GRAVITY = 0.055;

function playCollisionHaptic(firm: boolean) {
  if (Platform.OS === 'android') {
    void Haptics.performAndroidHapticsAsync(
      firm
        ? Haptics.AndroidHaptics.Segment_Tick
        : Haptics.AndroidHaptics.Segment_Frequent_Tick
    );
    return;
  }
  void Haptics.impactAsync(
    firm ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Soft
  );
}

interface TagMotion {
  x: SharedValue<number>;
  y: SharedValue<number>;
  angle: SharedValue<number>;
  vx: SharedValue<number>;
  vy: SharedValue<number>;
  angularVelocity: SharedValue<number>;
  enteredViewport: SharedValue<number>;
}

interface InterestTagsCanvasProps {
  selectedIds: Set<string>;
  onToggle: (tagId: string) => void;
  labelColor: string;
  outlineColor: string;
  /**
   * Height of the UI drawn over the BOTTOM of the canvas (the footer). The floor
   * is raised by this much so the pile settles above the button instead of behind
   * it — the canvas itself still spans the full screen, which is what lets the
   * tags drop in from behind the notch.
   */
  floorInset?: number;
}

/**
 * The falling, tappable, draggable interest tags.
 *
 * A Reanimated worklet owns the simulation and Skia draws it on the UI thread.
 * React never enters the frame loop: it re-renders only when selection changes.
 */
export function InterestTagsCanvas({
  selectedIds,
  onToggle,
  labelColor,
  outlineColor,
  floorInset = 0,
}: InterestTagsCanvasProps) {
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const initializedWorldRef = useRef<string | null>(null);
  const reducedMotion = useReducedMotion();
  const gravitySensor = useAnimatedSensor(SensorType.GRAVITY, { interval: 'auto' });
  const accelerationSensor = useAnimatedSensor(SensorType.ACCELEROMETER, {
    interval: 'auto',
  });
  const worldReady = useSharedValue(false);
  const draggedIndex = useSharedValue(-1);
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const dragLocalX = useSharedValue(0);
  const dragLocalY = useSharedValue(0);
  const hapticCooldown = useSharedValue(0);
  const filteredAccelerationX = useSharedValue(0);
  const filteredAccelerationY = useSharedValue(0);
  const previousGravityX = useSharedValue(0);
  const previousGravityY = useSharedValue(1);
  const sleepGravityX = useSharedValue(0);
  const sleepGravityY = useSharedValue(1);
  const sleepAccelerationX = useSharedValue(0);
  const sleepAccelerationY = useSharedValue(0);
  const quietTime = useSharedValue(0);
  const worldSleeping = useSharedValue(false);

  const font = useMemo(
    () =>
      matchFont({
        fontFamily: Platform.select({ ios: 'Helvetica Neue', android: 'sans-serif' }),
        fontSize: LABEL_FONT_SIZE,
        fontWeight: 'bold',
      }),
    []
  );

  const iconFont = useFont(iconFontFile, ICON_FONT_SIZE);

  // One set of shared values per tag, created once. `INTEREST_TAGS` is a static
  // list, so the count never changes.
  const motions = useMemo<TagMotion[]>(
    () =>
      INTEREST_TAGS.map(() => ({
        x: makeMutable(0),
        y: makeMutable(-TAG_HEIGHT),
        angle: makeMutable(0),
        vx: makeMutable(0),
        vy: makeMutable(0),
        angularVelocity: makeMutable(0),
        enteredViewport: makeMutable(0),
      })),
    []
  );

  // Widths depend on the measured label, and BOTH the bodies and the drawing need
  // them — derive them once.
  const tagWidths = useMemo(
    () =>
      font
        ? INTEREST_TAGS.map((tag) =>
            Math.max(MIN_TAG_WIDTH, ICON_AREA + font.getTextWidth(tag.label) + H_PADDING)
          )
        : null,
    [font]
  );

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setDimensions({ width, height });
  };

  useEffect(() => {
    if (!dimensions || !tagWidths) return;
    const worldKey = `${dimensions.width}:${dimensions.height}:${floorInset}`;
    if (initializedWorldRef.current === worldKey) return;
    initializedWorldRef.current = worldKey;
    worldReady.value = false;
    worldSleeping.value = false;
    quietTime.value = 0;

    for (let index = 0; index < motions.length; index += 1) {
      const width = tagWidths[index];
      const motion = motions[index];
      motion.x.value =
        Math.random() * (dimensions.width - width) + width / 2;
      motion.y.value = -TAG_HEIGHT - index * SPAWN_STAGGER;
      motion.angle.value = (Math.random() - 0.5) * 0.5;
      motion.vx.value = 0;
      motion.vy.value = 0;
      motion.angularVelocity.value = 0;
      motion.enteredViewport.value = 0;
    }
    worldReady.value = true;
  }, [
    dimensions,
    floorInset,
    motions,
    quietTime,
    tagWidths,
    worldReady,
    worldSleeping,
  ]);

  useFrameCallback((frame) => {
    'worklet';
    if (!dimensions || !tagWidths || !worldReady.value) return;

    const frameMilliseconds = frame.timeSincePreviousFrame ?? 1000 / 120;
    const gravity = gravitySensor.sensor.value;
    const acceleration = accelerationSensor.sensor.value;
    const gravityMagnitude = Math.hypot(gravity.x, gravity.y, gravity.z);
    let apparentX = 0;
    let apparentY = 1;
    let baseGravityX = 0;
    let baseGravityY = 1;
    let normalGravity = 0;

    if (!reducedMotion && gravityMagnitude > 1) {
      let shakeX = acceleration.x / EARTH_GRAVITY;
      let shakeY = -acceleration.y / EARTH_GRAVITY;
      const shakeMagnitude = Math.hypot(shakeX, shakeY);
      if (shakeMagnitude > MAX_SHAKE_GRAVITY) {
        const shakeScale = MAX_SHAKE_GRAVITY / shakeMagnitude;
        shakeX *= shakeScale;
        shakeY *= shakeScale;
      }

      // Remove single-sample sensor spikes without adding perceptible latency.
      const sensorResponse = 1 - Math.exp(-frameMilliseconds / ACCELEROMETER_RESPONSE_MS);
      filteredAccelerationX.value +=
        (shakeX - filteredAccelerationX.value) * sensorResponse;
      filteredAccelerationY.value +=
        (shakeY - filteredAccelerationY.value) * sensorResponse;

      baseGravityX = gravity.x / EARTH_GRAVITY;
      // When the phone lies flat, real gravity points through the display and
      // has no screen-plane Y component. For this little on-screen box, that is
      // the neutral pose: retain only a gentle downward bias. As the phone tilts
      // upright, it naturally hands over to the full screen-plane gravity.
      baseGravityY =
        (-gravity.y + Math.abs(gravity.z) * FLAT_NEUTRAL_DOWN_GRAVITY) /
        EARTH_GRAVITY;
      apparentX = baseGravityX + filteredAccelerationX.value;
      apparentY = baseGravityY + filteredAccelerationY.value;
      normalGravity = Math.abs(gravity.z) / EARTH_GRAVITY;
      const apparentMagnitude = Math.hypot(apparentX, apparentY);
      if (apparentMagnitude > MAX_APPARENT_GRAVITY) {
        const scale = MAX_APPARENT_GRAVITY / apparentMagnitude;
        apparentX *= scale;
        apparentY *= scale;
      }
    } else {
      filteredAccelerationX.value = 0;
      filteredAccelerationY.value = 0;
    }

    const inputDelta = Math.hypot(
      baseGravityX - previousGravityX.value,
      baseGravityY - previousGravityY.value
    );
    const shakeMagnitude = Math.hypot(
      filteredAccelerationX.value,
      filteredAccelerationY.value
    );
    previousGravityX.value = baseGravityX;
    previousGravityY.value = baseGravityY;

    if (worldSleeping.value) {
      const changeSinceSleep = Math.hypot(
        baseGravityX - sleepGravityX.value,
        baseGravityY - sleepGravityY.value
      );
      const shakeChangeSinceSleep = Math.hypot(
        filteredAccelerationX.value - sleepAccelerationX.value,
        filteredAccelerationY.value - sleepAccelerationY.value
      );
      if (
        draggedIndex.value < 0 &&
        changeSinceSleep < WAKE_INPUT_DELTA &&
        shakeChangeSinceSleep < WAKE_SHAKE_GRAVITY
      ) {
        hapticCooldown.value = Math.max(0, hapticCooldown.value - frameMilliseconds);
        return;
      }
      worldSleeping.value = false;
      quietTime.value = 0;
    }

    const bodies: WoodenPillBody[] = motions.map((motion, index) => {
      const width = tagWidths[index] + GAP;
      const height = TAG_HEIGHT + GAP;
      const mass = width / height;
      return {
        x: motion.x.value,
        y: motion.y.value,
        angle: motion.angle.value,
        vx: motion.vx.value,
        vy: motion.vy.value,
        angularVelocity: motion.angularVelocity.value,
        axisX: Math.cos(motion.angle.value),
        axisY: Math.sin(motion.angle.value),
        halfSegment: Math.max(0, (width - height) / 2),
        radius: height / 2,
        invMass: 1 / mass,
        invInertia: 12 / (mass * (width * width + height * height)),
        enteredViewport: motion.enteredViewport.value === 1,
        contacted: false,
      };
    });

    const maximumImpactSpeed = stepWoodenPills(bodies, {
      dt: frameMilliseconds / 1000,
      width: dimensions.width,
      height: dimensions.height - floorInset,
      gravityX: apparentX,
      gravityY: apparentY,
      normalGravity,
      draggedIndex: draggedIndex.value,
      dragX: dragX.value,
      dragY: dragY.value,
      dragLocalX: dragLocalX.value,
      dragLocalY: dragLocalY.value,
    });

    hapticCooldown.value = Math.max(0, hapticCooldown.value - frameMilliseconds);
    if (
      maximumImpactSpeed >= HAPTIC_IMPACT_SPEED &&
      hapticCooldown.value === 0
    ) {
      hapticCooldown.value = HAPTIC_COOLDOWN_MS;
      scheduleOnRN(
        playCollisionHaptic,
        maximumImpactSpeed >= FIRM_HAPTIC_IMPACT_SPEED
      );
    }

    let maximumBodySpeed = 0;
    let allBodiesSupported = true;
    for (let index = 0; index < bodies.length; index += 1) {
      const body = bodies[index];
      const motion = motions[index];
      if (
        body.x < -ESCAPE_MARGIN ||
        body.x > dimensions.width + ESCAPE_MARGIN ||
        body.y > dimensions.height + ESCAPE_MARGIN
      ) {
        body.x = dimensions.width / 2;
        body.y = -TAG_HEIGHT;
        body.vx = 0;
        body.vy = 0;
        body.angularVelocity = 0;
        body.enteredViewport = false;
      }
      maximumBodySpeed = Math.max(
        maximumBodySpeed,
        Math.hypot(body.vx, body.vy),
        Math.abs(body.angularVelocity) * body.radius
      );
      allBodiesSupported &&= body.enteredViewport && body.contacted;
      motion.x.value = body.x;
      motion.y.value = body.y;
      motion.angle.value = body.angle;
      motion.vx.value = body.vx;
      motion.vy.value = body.vy;
      motion.angularVelocity.value = body.angularVelocity;
      motion.enteredViewport.value = body.enteredViewport ? 1 : 0;
    }

    if (
      draggedIndex.value < 0 &&
      allBodiesSupported &&
      inputDelta < QUIET_INPUT_DELTA &&
      shakeMagnitude < QUIET_SHAKE_GRAVITY &&
      maximumBodySpeed < WORLD_SLEEP_SPEED
    ) {
      quietTime.value += frameMilliseconds;
      if (quietTime.value >= WORLD_SLEEP_DELAY_MS) {
        worldSleeping.value = true;
        sleepGravityX.value = baseGravityX;
        sleepGravityY.value = baseGravityY;
        sleepAccelerationX.value = filteredAccelerationX.value;
        sleepAccelerationY.value = filteredAccelerationY.value;
        for (const motion of motions) {
          motion.vx.value = 0;
          motion.vy.value = 0;
          motion.angularVelocity.value = 0;
        }
      }
    } else {
      quietTime.value = 0;
    }
  });

  const gesture = useMemo(() => {
    const bodyAt = (x: number, y: number) => {
      'worklet';
      if (!tagWidths) return -1;
      for (let index = motions.length - 1; index >= 0; index -= 1) {
        const motion = motions[index];
        const width = tagWidths[index] + GAP;
        const height = TAG_HEIGHT + GAP;
        if (
          hitTestWoodenPill(
            x,
            y,
            motion.x.value,
            motion.y.value,
            motion.angle.value,
            Math.max(0, (width - height) / 2),
            height / 2
          )
        ) {
          return index;
        }
      }
      return -1;
    };

    const tap = Gesture.Tap().onStart((event) => {
      const index = bodyAt(event.x, event.y);
      if (index < 0) return;

      worldSleeping.value = false;
      quietTime.value = 0;
      motions[index].vy.value += TAP_IMPULSE_Y;
      scheduleOnRN(onToggle, INTEREST_TAGS[index].id);
    });

    const pan = Gesture.Pan()
      .minDistance(3)
      .onStart((event) => {
        const index = bodyAt(event.x, event.y);
        if (index < 0) return;
        worldSleeping.value = false;
        quietTime.value = 0;
        const motion = motions[index];
        const dx = event.x - motion.x.value;
        const dy = event.y - motion.y.value;
        const cos = Math.cos(motion.angle.value);
        const sin = Math.sin(motion.angle.value);
        draggedIndex.value = index;
        dragX.value = event.x;
        dragY.value = event.y;
        dragLocalX.value = dx * cos + dy * sin;
        dragLocalY.value = -dx * sin + dy * cos;
      })
      .onUpdate((event) => {
        if (draggedIndex.value < 0) return;
        dragX.value = event.x;
        dragY.value = event.y;
      })
      .onEnd((event) => {
        const index = draggedIndex.value;
        if (index < 0) return;
        motions[index].vx.value = event.velocityX;
        motions[index].vy.value = event.velocityY;
      })
      .onFinalize(() => {
        draggedIndex.value = -1;
      });

    return Gesture.Race(pan, tap);
  }, [
    dragLocalX,
    dragLocalY,
    dragX,
    dragY,
    draggedIndex,
    motions,
    onToggle,
    quietTime,
    tagWidths,
    worldSleeping,
  ]);

  if (!font || !iconFont || !tagWidths) return null;

  return (
    <View style={styles.root} onLayout={onLayout}>
      {dimensions && (
        <GestureDetector gesture={gesture}>
          <Canvas style={StyleSheet.absoluteFill}>
            {INTEREST_TAGS.map((tag, index) => (
              <TagBody
                key={tag.id}
                motion={motions[index]}
                width={tagWidths[index]}
                color={tag.color}
                label={tag.label}
                glyph={ICON_GLYPHS[tag.icon]}
                selected={selectedIds.has(tag.id)}
                labelColor={labelColor}
                outlineColor={outlineColor}
                font={font}
                iconFont={iconFont}
              />
            ))}
          </Canvas>
        </GestureDetector>
      )}
    </View>
  );
}

interface TagBodyProps {
  motion: TagMotion;
  width: number;
  color: string;
  label: string;
  glyph: string | undefined;
  selected: boolean;
  labelColor: string;
  outlineColor: string;
  font: NonNullable<ReturnType<typeof matchFont>>;
  iconFont: NonNullable<ReturnType<typeof useFont>>;
}

/**
 * One tag, drawn in LOCAL coordinates around its own centre. Only the `Group`
 * transform changes per frame, and it comes from shared values — so a frame costs
 * a transform update, not a React render.
 */
const TagBody = React.memo(function TagBody({
  motion,
  width,
  color,
  label,
  glyph,
  selected,
  labelColor,
  outlineColor,
  font,
  iconFont,
}: TagBodyProps) {
  const transform = useDerivedValue(() => [
    { translateX: motion.x.value },
    { translateY: motion.y.value },
    { rotate: motion.angle.value },
  ]);

  const left = -width / 2;

  return (
    <Group transform={transform}>
      <RoundedRect
        x={left}
        y={-TAG_HEIGHT / 2}
        width={width}
        height={TAG_HEIGHT}
        r={TAG_RADIUS}
        color={color}
      />

      {selected && (
        <RoundedRect
          x={left}
          y={-TAG_HEIGHT / 2}
          width={width}
          height={TAG_HEIGHT}
          r={TAG_RADIUS}
          color={outlineColor}
          style="stroke"
          strokeWidth={3}
        />
      )}

      {glyph && (
        <SkiaText
          x={left + 12}
          y={iconFont.getSize() / 3}
          text={glyph}
          font={iconFont}
          color={labelColor}
        />
      )}

      <SkiaText
        x={left + ICON_AREA}
        y={font.getSize() / 3}
        text={label}
        font={font}
        color={labelColor}
      />
    </Group>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1 },
});
