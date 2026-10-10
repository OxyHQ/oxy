import type React from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';

interface FAIRWalletIconProps {
  size?: number;
  style?: StyleProp<ViewStyle>;
}

const FAIRWalletIcon: React.FC<FAIRWalletIconProps> = ({ size = 28, style }) => {
  const containerSize = size + 18;
  return (
    <View
      style={[
        styles.circle,
        { width: containerSize, height: containerSize, borderRadius: containerSize / 2 },
        style,
      ]}
    >
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Svg
          viewBox="0 0 157.26 85.66"
          width={containerSize * 0.8}
          height={containerSize * 0.8}
          preserveAspectRatio="xMidYMid meet"
        >
          <G data-name="Layer 2">
            <G data-name="Layer 1">
              <Path
                d="M10.25,20.81a20.49,20.49,0,0,1,28,7.5L53.6,54.92a20.49,20.49,0,0,1-7.5,28h0a20.49,20.49,0,0,1-28-7.5L2.75,48.8a20.49,20.49,0,0,1,7.5-28Z"
                fill="rgb(159, 251, 80)"
              />
              <Path
                d="M74.38,2.75a20.49,20.49,0,0,0-28,7.5L20.6,54.92a20.5,20.5,0,0,0,7.5,28h0a20.5,20.5,0,0,0,28-7.5L81.88,30.74a20.48,20.48,0,0,0-7.5-28Z"
                fill="rgb(159, 251, 80)"
              />
              <Path
                d="M127.87,2.75a20.49,20.49,0,0,0-28,7.5L74.09,54.92a20.49,20.49,0,0,0,7.5,28h0a20.49,20.49,0,0,0,28-7.5l25.79-44.67a20.49,20.49,0,0,0-7.5-28Z"
                fill="rgb(255, 255, 255)"
              />
              <Path
                d="M121.84,67.51a17.71,17.71,0,1,1,17.71,17.71,17.71,17.71,0,0,1-17.71-17.71Z"
                fill="rgb(255, 255, 255)"
              />
            </G>
          </G>
        </Svg>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  circle: {
    backgroundColor: '#1b1f0a',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default FAIRWalletIcon;
