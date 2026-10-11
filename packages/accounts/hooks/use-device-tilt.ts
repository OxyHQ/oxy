import { useEffect, useRef } from 'react';
import { Gyroscope, GyroscopeMeasurement } from 'expo-sensors';
import { useSharedValue } from 'react-native-reanimated';

export const useDeviceTilt = () => {
  // Shared values for rotation angles (in degrees)
  const rotateX = useSharedValue(0); // Pitch (forward/backward)
  const rotateY = useSharedValue(0); // Roll (left/right)

  // Track last update time for integration
  const lastUpdateTime = useRef<number | null>(null);

  useEffect(() => {
    let subscription: { remove: () => void } | null = null;

    // Check if gyroscope is available
    Gyroscope.isAvailableAsync().then((available: boolean) => {
      if (!available) {
        console.warn('Gyroscope is not available on this device');
        return;
      }

      // Request permissions
      Gyroscope.requestPermissionsAsync().then((permission) => {
        if (!permission.granted) {
          console.warn('Gyroscope permissions not granted');
          return;
        }

        // Set update interval to ~60fps
        Gyroscope.setUpdateInterval(16);

        // Subscribe to gyroscope updates - integrate rotation rates
        subscription = Gyroscope.addListener((data: GyroscopeMeasurement) => {
          const now = data.timestamp;

          if (lastUpdateTime.current === null) {
            lastUpdateTime.current = now;
            return;
          }

          // Calculate time delta in seconds
          const deltaTime = (now - lastUpdateTime.current) / 1000;
          lastUpdateTime.current = now;

          // Convert rotation rates (rad/s) to degrees and integrate
          // X axis rotation (pitch) - forward/backward tilt
          const deltaX = ((data.x * 180) / Math.PI) * deltaTime;
          // Y axis rotation (roll) - left/right tilt
          const deltaY = ((data.y * 180) / Math.PI) * deltaTime;

          // Apply rotation with limits (Airbnb-style: ±15 degrees) and damping
          const maxRotation = 15;
          const damping = 0.95; // Slight damping to prevent infinite accumulation

          // Apply rotation with damping (returns to center when device stops)
          const newRotateX = rotateX.value * damping + deltaX * 0.5;
          const newRotateY = rotateY.value * damping + deltaY * 0.5;

          rotateX.value = Math.max(-maxRotation, Math.min(maxRotation, newRotateX));
          rotateY.value = Math.max(-maxRotation, Math.min(maxRotation, newRotateY));
        });
      });
    });

    // Cleanup on unmount
    return () => {
      if (subscription) {
        subscription.remove();
      }
      Gyroscope.removeAllListeners();
      lastUpdateTime.current = null;
    };
  }, []); // rotateX and rotateY are stable SharedValue references

  return {
    rotateX, // Pitch (forward/backward)
    rotateY, // Roll (left/right)
  };
};
