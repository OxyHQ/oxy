import React from 'react';
import { StyleSheet, View } from 'react-native';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { AccountCard } from '@/components/ui';

/** The placeholder sections and their row keys — the recommendation, sign-in and device lists run about this long. */
const SECTIONS = [
  { key: 'recommendations', rows: ['r1', 'r2', 'r3'] },
  { key: 'sign-in', rows: ['s1', 's2'] },
  { key: 'devices', rows: ['d1', 'd2', 'd3'] },
] as const;

/**
 * The security screen while its devices and account load: the sections'
 * shape (a heading, then a card of icon + two-line rows), so nothing jumps
 * when they arrive. Named for assistive technology by the caller's `label`.
 */
export function SecuritySkeleton({ label }: { label: string }) {
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      aria-busy
      style={styles.container}
      testID="security-skeleton"
    >
      {SECTIONS.map((section) => (
        <View key={section.key} style={styles.section}>
          <Skeleton.Text style={styles.heading} />
          <AccountCard>
            {section.rows.map((row, index) => (
              <Skeleton.Row key={row} style={styles.row}>
                <Skeleton.Circle size={36} />
                <Skeleton.Col style={styles.lines}>
                  <Skeleton.Text style={index % 2 === 0 ? styles.titleWide : styles.titleNarrow} />
                  <Skeleton.Text style={styles.subtitle} />
                </Skeleton.Col>
              </Skeleton.Row>
            ))}
          </AccountCard>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 24,
  },
  section: {
    gap: 12,
  },
  heading: {
    width: 160,
    fontSize: 18,
    lineHeight: 24,
  },
  row: {
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  lines: {
    flex: 1,
    gap: 6,
  },
  titleWide: {
    width: '60%',
    fontSize: 16,
    lineHeight: 20,
  },
  titleNarrow: {
    width: '45%',
    fontSize: 16,
    lineHeight: 20,
  },
  subtitle: {
    width: '35%',
    fontSize: 13,
    lineHeight: 18,
  },
});
