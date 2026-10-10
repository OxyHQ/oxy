/**
 * Device-attitude tilt for the Oxy ID card.
 *
 * Unlike a gyroscope-rate integration (which drifts and self-damps back to
 * center), this reads the phone's ABSOLUTE orientation from the rotation
 * sensor and reports how far it is tilted away from the pose the card was
 * first shown in. The result is drift-free: the card reflects how the phone is
 * actually held and holds still when the phone does.
 *
 * All outputs are UI-thread shared values updated inside a single
 * `useFrameCallback` worklet (or, on devices without the reanimated rotation
 * sensor, a JS-thread `DeviceMotion` fallback). Nothing here triggers a React
 * re-render.
 *
 *   roll  -> yaw   (drives rotateY: the card turns left/right into the tilt)
 *   pitch -> pitch (drives rotateX: the card tips toward/away from the viewer)
 */

import { useEffect } from 'react';

import { DeviceMotion, type DeviceMotionMeasurement } from 'expo-sensors';
import {
  SensorType,
  useAnimatedSensor,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

// Max tilt in degrees, sensor-to-card gain, and low-pass smoothing factor.
// Deliberately gentle — the card should tip subtly, not swing.
const MAX = 9;
const GAIN = 0.4;
const ALPHA = 0.1;
const RAD_TO_DEG = 180 / Math.PI;
// Dead-zone (degrees): below this per-frame change we DON'T write the shared
// values, so at rest the derived Skia values stop updating and the canvases go
// idle instead of redrawing every frame on sensor noise.
const SETTLE = 0.02;

export interface DeviceTilt {
  /** Card pitch in degrees (rotateX), clamped to [-MAX, MAX]. */
  pitchDeg: SharedValue<number>;
  /** Card yaw in degrees (rotateY), clamped to [-MAX, MAX]. */
  yawDeg: SharedValue<number>;
  /** Normalized horizontal tilt in [-1, 1] (yaw / MAX). */
  nx: SharedValue<number>;
  /** Normalized vertical tilt in [-1, 1] (pitch / MAX). */
  ny: SharedValue<number>;
  /** Overall tilt magnitude in [0, 1]. */
  mag: SharedValue<number>;
  /** True when a live motion source is driving the values (not reduced-motion). */
  motionEnabled: boolean;
}

export const useDeviceTilt = (): DeviceTilt => {
  const pitchDeg = useSharedValue(0);
  const yawDeg = useSharedValue(0);
  const nx = useSharedValue(0);
  const ny = useSharedValue(0);
  const mag = useSharedValue(0);

  // Rest attitude captured on the first frame; tilt is measured relative to it.
  const originPitch = useSharedValue(0);
  const originRoll = useSharedValue(0);
  const hasOrigin = useSharedValue(false);

  const reducedMotion = useReducedMotion();
  const sensor = useAnimatedSensor(SensorType.ROTATION, {
    interval: 16,
    adjustToInterfaceOrientation: true,
  });

  const sensorAvailable = sensor.isAvailable;
  const motionEnabled = sensorAvailable && !reducedMotion;

  // Only the SharedValue is captured by the worklet, never the AnimatedSensor
  // object (which holds non-serializable functions).
  const rotationSensor = sensor.sensor;

  useFrameCallback(() => {
    'worklet';
    if (!motionEnabled) {
      return;
    }
    const s = rotationSensor.value;
    const rawPitch = s.pitch ?? 0;
    const rawRoll = s.roll ?? 0;

    if (!hasOrigin.value) {
      originPitch.value = rawPitch;
      originRoll.value = rawRoll;
      hasOrigin.value = true;
      return;
    }

    const targetPitch = Math.max(
      -MAX,
      Math.min(MAX, (rawPitch - originPitch.value) * RAD_TO_DEG * GAIN),
    );
    // Roll drives yaw so the card turns INTO the tilt (rotateY), not spins flat.
    const targetYaw = Math.max(
      -MAX,
      Math.min(MAX, (rawRoll - originRoll.value) * RAD_TO_DEG * GAIN),
    );

    const nextPitch = pitchDeg.value + ALPHA * (targetPitch - pitchDeg.value);
    const nextYaw = yawDeg.value + ALPHA * (targetYaw - yawDeg.value);

    // Dead-zone: once the low-pass has settled and only sensor noise remains,
    // stop writing so the Skia canvases stop redrawing on a still phone.
    if (
      Math.abs(nextPitch - pitchDeg.value) < SETTLE &&
      Math.abs(nextYaw - yawDeg.value) < SETTLE
    ) {
      return;
    }

    pitchDeg.value = nextPitch;
    yawDeg.value = nextYaw;

    const nxv = Math.max(-1, Math.min(1, nextYaw / MAX));
    const nyv = Math.max(-1, Math.min(1, nextPitch / MAX));
    nx.value = nxv;
    ny.value = nyv;
    mag.value = Math.min(1, Math.sqrt(nxv * nxv + nyv * nyv));
  }, true);

  // Release the sensor whenever motion is disabled (reduced motion or no sensor).
  useEffect(() => {
    if (!motionEnabled) {
      sensor.unregister();
    }
  }, [motionEnabled, sensor]);

  // Fallback for devices without the reanimated rotation sensor: drive the
  // same shared values from expo-sensors' DeviceMotion on the JS thread.
  useEffect(() => {
    if (sensorAvailable || reducedMotion) {
      return;
    }

    let active = true;
    let origin: { beta: number; gamma: number } | null = null;
    let filtPitch = 0;
    let filtYaw = 0;
    let sub: { remove: () => void } | null = null;

    DeviceMotion.isAvailableAsync()
      .then((available) => {
        if (!available || !active) {
          return;
        }
        DeviceMotion.setUpdateInterval(16);
        sub = DeviceMotion.addListener((data: DeviceMotionMeasurement) => {
          const rotation = data.rotation;
          if (!rotation) {
            return;
          }
          // beta = X-axis (pitch), gamma = Y-axis (roll) — radians on native.
          const beta = rotation.beta ?? 0;
          const gamma = rotation.gamma ?? 0;
          if (!origin) {
            origin = { beta, gamma };
            return;
          }
          const targetPitch = Math.max(
            -MAX,
            Math.min(MAX, (beta - origin.beta) * RAD_TO_DEG * GAIN),
          );
          const targetYaw = Math.max(
            -MAX,
            Math.min(MAX, (gamma - origin.gamma) * RAD_TO_DEG * GAIN),
          );
          filtPitch += ALPHA * (targetPitch - filtPitch);
          filtYaw += ALPHA * (targetYaw - filtYaw);
          pitchDeg.value = filtPitch;
          yawDeg.value = filtYaw;

          const nxv = Math.max(-1, Math.min(1, filtYaw / MAX));
          const nyv = Math.max(-1, Math.min(1, filtPitch / MAX));
          nx.value = nxv;
          ny.value = nyv;
          mag.value = Math.min(1, Math.sqrt(nxv * nxv + nyv * nyv));
        });
      })
      .catch((error: unknown) => {
        // No usable motion source — the card stays flat. Surface the reason
        // so a genuinely broken sensor pipeline is diagnosable.
        console.warn('[useDeviceTilt] DeviceMotion unavailable', error);
      });

    return () => {
      active = false;
      sub?.remove();
    };
  }, [sensorAvailable, reducedMotion, pitchDeg, yawDeg, nx, ny, mag]);

  return { pitchDeg, yawDeg, nx, ny, mag, motionEnabled };
};
