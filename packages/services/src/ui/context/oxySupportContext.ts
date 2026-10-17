import { createContext, type ReactNode } from 'react';

/** Host-owned support integration; keeps Alia an optional dependency. */
export const OxySupportContext = createContext<{
  onAskAlia?: () => void | Promise<void>;
  documentationUrl?: string;
  aliaAvatar?: ReactNode;
  oxyOneArtwork?: ReactNode;
}>({});
