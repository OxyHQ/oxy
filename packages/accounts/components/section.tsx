import React from 'react';
import {
  View,
  StyleSheet,
  Platform,
  type Falsy,
  type RecursiveArray,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { ThemedText } from './themed-text';

/**
 * The structural form a `StyleProp<TextStyle>` takes once registered-style
 * numbers are excluded: a plain style object, an (optionally nested) array of
 * them, or a falsy value. This is what we can actually introspect for the
 * sectionSubtitle heuristic — registered StyleSheet ids are opaque numbers.
 */
type InspectableStyle =
  | TextStyle
  | Falsy
  | RecursiveArray<TextStyle | Falsy>
  | readonly (TextStyle | Falsy)[];

interface SectionProps {
  title?: string;
  children: React.ReactNode;
  isFirst?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Section({ title, children, isFirst = false, style }: SectionProps) {
  // Check if first child is a description (ThemedText with sectionSubtitle style)
  const childrenArray = React.Children.toArray(children);
  const firstChild = childrenArray[0];

  // Helper to check if a style matches sectionSubtitle (fontSize 14, opacity 0.7)
  const isSectionSubtitleStyle = (styleObj: InspectableStyle): boolean => {
    if (!styleObj) return false;
    if (Array.isArray(styleObj)) {
      return styleObj.some((entry) => isSectionSubtitleStyle(entry));
    }
    // Registered StyleSheet styles surface as numeric ids at runtime; only
    // inline object styles carry the inspectable fontSize/opacity fields.
    if (typeof styleObj !== 'object') return false;
    const flat = styleObj as TextStyle;
    return flat.fontSize === 14 && flat.opacity === 0.7;
  };

  const isFirstChildDescription =
    React.isValidElement(firstChild) &&
    firstChild.type === ThemedText &&
    isSectionSubtitleStyle((firstChild.props as { style?: InspectableStyle }).style);

  const description = isFirstChildDescription ? firstChild : null;
  const content = isFirstChildDescription ? childrenArray.slice(1) : childrenArray;

  return (
    <View style={[styles.section, isFirst && styles.firstSection, style]}>
      {(title || description) && (
        <View style={styles.headerContainer}>
          {title && <ThemedText style={styles.sectionTitle}>{title}</ThemedText>}
          {description}
        </View>
      )}
      {content.length > 0 && <View style={styles.contentContainer}>{content}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: 24,
    gap: 12,
  },
  firstSection: {
    marginTop: 0,
  },
  headerContainer: {
    gap: 2,
  },
  contentContainer: {
    gap: 0,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: Platform.OS === 'web' ? '600' : undefined,
  },
});
