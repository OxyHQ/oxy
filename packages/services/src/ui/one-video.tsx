/** Optional video entry: never re-export from services or its UI root barrels. */
import { useEffect } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useVideoPlayer } from 'expo-video';
import { VideoView } from '@oxy.so/bloom/video-view';
import { useReducedMotion } from 'react-native-reanimated';
import floralVideo from '../assets/one/floral.mp4';
import floralPoster from '../assets/one/floral.jpg';

/** Muted decorative artwork. Bloom's SubscriptionPlans owns its fade and layout. */
export function OxyOneVideo() {
  const reducedMotion = useReducedMotion();
  const player = useVideoPlayer(reducedMotion ? null : floralVideo, (video) => {
    video.muted = true;
    video.loop = true;
  });
  useEffect(() => {
    const update = (state: string | null | undefined) => {
      if (!reducedMotion && state === 'active') player.play();
      else player.pause();
    };
    update(AppState.currentState);
    const subscription = AppState.addEventListener('change', update);
    return () => subscription.remove();
  }, [player, reducedMotion]);
  return (
    <View
      style={StyleSheet.absoluteFill}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <ExpoImage source={floralPoster} contentFit="cover" style={StyleSheet.absoluteFill} />
      {!reducedMotion && (
        <VideoView
          player={player}
          nativeControls={false}
          contentFit="cover"
          surfaceType="textureView"
          style={StyleSheet.absoluteFill}
        />
      )}
    </View>
  );
}
