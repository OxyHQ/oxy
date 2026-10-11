import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';

interface AccountCardProps {
  children: React.ReactNode;
}

export function AccountCard({ children }: AccountCardProps) {
  const colors = useColors();

  return <View style={[styles.accountCard, { backgroundColor: colors.card }]}>{children}</View>;
}

const styles = StyleSheet.create({
  accountCard: {
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 16,
  },
});
