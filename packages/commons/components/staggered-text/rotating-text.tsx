import React, { useEffect, useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, type ViewStyle, type TextStyle, LayoutChangeEvent } from 'react-native';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withTiming,
    Easing,
    runOnJS,
} from 'react-native-reanimated';

type TextItem = string | string[];

interface RotatingTextAnimationProps {
    texts: TextItem[];
    fontSize?: number;
    lineHeight?: number;
    interval?: number;
    duration?: number;
    textStyle?: TextStyle;
    containerStyle?: ViewStyle;
}

export function RotatingTextAnimation({
    texts,
    fontSize = 64,
    lineHeight,
    interval = 3000,
    duration = 600,
    textStyle,
    containerStyle,
}: RotatingTextAnimationProps) {
    // Calculate lineHeight based on fontSize if not provided (1.4x multiplier for better spacing)
    const calculatedLineHeight = lineHeight ?? fontSize * 1.4;
    const translateY = useSharedValue(0);
    const containerHeight = useSharedValue(calculatedLineHeight);
    const indexRef = React.useRef(0);

    // Store measured heights for each text item
    const [measuredHeights, setMeasuredHeights] = useState<Map<number, number>>(new Map());

    // Normalize texts: convert strings to arrays for consistent handling
    const normalizedTexts = useMemo(() => {
        return texts.map(text => Array.isArray(text) ? text : [text]);
    }, [texts]);

    // Calculate heights for each text item
    // Use measured heights if available, otherwise estimate based on text length
    const textHeights = useMemo(() => {
        return normalizedTexts.map((lines, index) => {
            // If we have a measured height, use it (phrases may wrap naturally)
            const measured = measuredHeights.get(index);
            if (measured) {
                return measured;
            }

            // If it's explicitly split into multiple lines, use that
            if (lines.length > 1) {
                return lines.length * calculatedLineHeight;
            }

            // Estimate height for single-line strings that might wrap
            // Longer phrases are more likely to wrap, so estimate more height
            const text = lines[0];
            const estimatedLines = Math.max(1, Math.ceil(text.length / 15)); // Rough estimate: ~15 chars per line
            return estimatedLines * calculatedLineHeight;
        });
    }, [normalizedTexts, calculatedLineHeight, measuredHeights]);

    // Calculate cumulative positions for each text item
    const textPositions = useMemo(() => {
        const positions: number[] = [];
        let currentPosition = 0;
        textHeights.forEach(height => {
            positions.push(currentPosition);
            currentPosition += height;
        });
        return positions;
    }, [textHeights]);

    // Total height of all texts combined
    const totalHeight = useMemo(() => {
        return textHeights.reduce((sum, height) => sum + height, 0);
    }, [textHeights]);

    // Optimized: Render only 2 copies instead of 3 for better performance
    // Still maintains seamless looping while reducing render count by 33%
    const textList = useMemo(() => {
        return [...normalizedTexts, ...normalizedTexts];
    }, [normalizedTexts]);

    // Calculate positions for the doubled list
    const textListPositions = useMemo(() => {
        const positions: number[] = [];
        let currentPosition = 0;
        textList.forEach((lines, index) => {
            positions.push(currentPosition);
            const originalIndex = index % normalizedTexts.length;
            const height = textHeights[originalIndex] || lines.length * calculatedLineHeight;
            currentPosition += height;
        });
        return positions;
    }, [textList, textHeights, normalizedTexts.length, calculatedLineHeight]);

    const rotatingStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: translateY.value }],
    }));

    const containerAnimatedStyle = useAnimatedStyle(() => ({
        height: containerHeight.value,
    }));

    const onRotationComplete = useCallback(() => {
        indexRef.current = (indexRef.current + 1) % texts.length;
        // Reset to start of first section when we reach end of second section
        // This creates seamless loop with only 2 copies
        if (indexRef.current === 0) {
            translateY.value = -totalHeight;
        } else {
            const resetPosition = totalHeight + textPositions[indexRef.current];
            translateY.value = -resetPosition;
        }

        // Update container height to match the new current item
        const newHeight = textHeights[indexRef.current] || calculatedLineHeight;
        containerHeight.value = withTiming(newHeight, {
            duration: duration * 0.5,
            easing: Easing.out(Easing.cubic),
        });
    }, [texts.length, totalHeight, textPositions, textHeights, calculatedLineHeight, duration, translateY, containerHeight]);


    useEffect(() => {
        let isActive = true;
        let intervalId: ReturnType<typeof setInterval>;

        const startRotation = () => {
            intervalId = setInterval(() => {
                if (!isActive) return;

                // Calculate the height of the current text item
                const currentTextHeight = textHeights[indexRef.current];

                // Get the next item's height for container resize
                const nextIndex = (indexRef.current + 1) % texts.length;
                const nextTextHeight = textHeights[nextIndex] || calculatedLineHeight;

                // Update container height to match next item (animate smoothly)
                containerHeight.value = withTiming(nextTextHeight, {
                    duration: duration * 0.8,
                    easing: Easing.out(Easing.cubic),
                });

                // Animate upward - slide current text up, next text appears from below
                // Use linear easing for smoother continuous motion
                translateY.value = withTiming(
                    translateY.value - currentTextHeight,
                    {
                        duration,
                        easing: Easing.linear,
                    },
                    (finished) => {
                        if (finished && isActive) {
                            runOnJS(onRotationComplete)();
                        }
                    }
                );
            }, interval);
        };

        const startDelay = setTimeout(startRotation, interval);

        return () => {
            isActive = false;
            clearTimeout(startDelay);
            clearInterval(intervalId);
        };
    }, [texts, textHeights, totalHeight, interval, duration, calculatedLineHeight, translateY, containerHeight, onRotationComplete]);

    // Consolidated initialization and height updates
    useEffect(() => {
        if (totalHeight > 0 && textHeights.length > 0) {
            // Position first text of middle section at the top of container
            translateY.value = -totalHeight;
            indexRef.current = 0;
            // Set initial container height to match first item
            const initialHeight = textHeights[0] || calculatedLineHeight;
            containerHeight.value = initialHeight;
        }
    }, [totalHeight, textHeights.length, calculatedLineHeight, translateY, containerHeight]);

    // Handle layout measurement for actual text heights
    const handleTextLayout = useCallback((index: number, height: number) => {
        setMeasuredHeights(prev => {
            const newMap = new Map(prev);
            // Map back to original index (accounting for tripled list)
            const originalIndex = index % normalizedTexts.length;
            // Only update if the measured height is significantly different
            const current = prev.get(originalIndex);
            if (!current || Math.abs(current - height) > 2) {
                newMap.set(originalIndex, height);

                // If this is the currently visible item, update container height immediately
                if (originalIndex === indexRef.current) {
                    containerHeight.value = withTiming(height, {
                        duration: 200,
                        easing: Easing.out(Easing.cubic),
                    });
                }

                return newMap;
            }
            return prev;
        });
    }, [normalizedTexts.length, containerHeight]);

    return (
        // Decorative: the drum holds every phrase at once (plus the copies that
        // make it loop), so exposed it reads as a list of fragments. The screen
        // that mounts it names the sentence it completes, once.
        <Animated.View style={[styles.container, containerAnimatedStyle, containerStyle]} aria-hidden>
            <Animated.View style={[rotatingStyle, { overflow: 'visible' }]}>
                {textList.map((lines, index) => {
                    const absolutePosition = textListPositions[index];
                    const originalIndex = index % normalizedTexts.length;
                    const itemHeight = textHeights[originalIndex] || lines.length * calculatedLineHeight;

                    return (
                        <AnimatedTextItem
                            key={index}
                            lines={lines}
                            fontSize={fontSize}
                            lineHeight={calculatedLineHeight}
                            itemHeight={itemHeight}
                            textStyle={textStyle}
                            absolutePosition={absolutePosition}
                            translateY={translateY}
                            onLayout={(height) => handleTextLayout(index, height)}
                        />
                    );
                })}
            </Animated.View>
        </Animated.View>
    );
}

// Separate component to handle text item opacity based on position
interface AnimatedTextItemProps {
    lines: string[];
    fontSize: number;
    lineHeight: number;
    itemHeight: number;
    textStyle?: TextStyle;
    absolutePosition: number;
    translateY: ReturnType<typeof useSharedValue<number>>;
    onLayout?: (height: number) => void;
}

const AnimatedTextItem = React.memo(function AnimatedTextItem({
    lines,
    fontSize,
    lineHeight,
    itemHeight,
    textStyle,
    absolutePosition,
    translateY,
    onLayout,
}: AnimatedTextItemProps) {
    const handleLayout = useCallback((event: LayoutChangeEvent) => {
        const { height } = event.nativeEvent.layout;
        if (onLayout && height > 0) {
            onLayout(height);
        }
    }, [onLayout]);

    // Optimized animated style with simplified calculations
    const animatedStyle = useAnimatedStyle(() => {
        'worklet';
        const screenPosition = absolutePosition + translateY.value;
        const fadeRange = itemHeight * 0.4;
        
        // Simplified opacity calculation
        let opacity = 0;
        if (screenPosition <= 0 && screenPosition >= -fadeRange) {
            opacity = Math.max(0, 1 + (screenPosition / fadeRange));
        } else if (screenPosition > 0 && screenPosition <= fadeRange) {
            opacity = 1 - (screenPosition / fadeRange);
        }
        
        // Simplified rotation calculation
        const rotationX = (screenPosition / itemHeight) * -90;

        return {
            opacity,
            transform: [{ rotateX: `${rotationX}deg` }],
        };
    });

    return (
        <Animated.View
            style={[styles.textItem, { minHeight: itemHeight }, animatedStyle]}
            onLayout={handleLayout}
        >
            {lines.map((line, lineIndex) => (
                <View key={lineIndex} style={styles.textLine}>
                    <Text style={[textStyle, { fontSize, lineHeight }]}>
                        {line}
                    </Text>
                </View>
            ))}
        </Animated.View>
    );
});

const styles = StyleSheet.create({
    container: {
        overflow: 'hidden',
        width: '100%',
    },
    textItem: {
        width: '100%',
        minWidth: '100%',
        overflow: 'visible',
        backfaceVisibility: 'hidden',
        margin: 0,
        padding: 0,
    },
    textLine: {
        justifyContent: 'flex-start',
        alignItems: 'flex-start',
        width: '100%',
        minWidth: '100%',
        overflow: 'visible',
        margin: 0,
        padding: 0,
        flexShrink: 0,
        flexWrap: 'wrap',
    },
});
