import React from 'react';

/**
 * Lightweight `@oxy.so/bloom/divider` stub — `useTheme()`, as with every other
 * Bloom family this suite stubs. A rule renders nothing a test can assert on,
 * but its CHILDREN can be a label, so those pass through.
 */
export function Divider({ children }: { children?: React.ReactNode; [key: string]: unknown }) {
  return children ? React.createElement('div', null, children) : React.createElement('hr');
}

export default Divider;
