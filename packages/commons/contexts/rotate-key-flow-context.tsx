import React, { createContext, useContext, useRef, useState, useCallback, useEffect, ReactNode } from 'react';
import type { PendingIdentityResult, RotateKeyProof } from '@oxy.so/core';

interface RotateKeyFlowValue {
  /**
   * How the user proves control of the CURRENT key:
   *  - `'device'`: sign with the on-device key (Path A).
   *  - `'phrase'`: re-derive the current key from the entered recovery phrase
   *    (Path B — used when the device key is lost / to replace the last credential).
   */
  proof: RotateKeyProof | null;
  setProof: (proof: RotateKeyProof) => void;
  /**
   * The CURRENT recovery phrase for phrase-proof rotation. In-memory ONLY — never
   * persisted. Populated on the "enter current phrase" step (Path B).
   */
  currentPhraseRef: React.MutableRefObject<string | null>;
  /**
   * The pre-derived NEW identity shown to the user BEFORE the server call, so the
   * phrase displayed is the exact one committed. In-memory ONLY — never persisted.
   */
  pendingIdentityRef: React.MutableRefObject<PendingIdentityResult | null>;
  /** Scrub all in-memory flow state (phrase + pending identity + proof). */
  reset: () => void;
}

const RotateKeyFlowContext = createContext<RotateKeyFlowValue | undefined>(undefined);

/**
 * Shares the key-rotation flow state across its stacked screens (entry →
 * current-phrase → new recovery phrase → confirm). The recovery phrase and the
 * pre-derived new identity are held in refs so they survive navigation but are
 * NEVER written to storage, and are scrubbed on unmount as defense-in-depth.
 */
export function RotateKeyFlowProvider({ children }: { children: ReactNode }) {
  const [proof, setProof] = useState<RotateKeyProof | null>(null);
  const currentPhraseRef = useRef<string | null>(null);
  const pendingIdentityRef = useRef<PendingIdentityResult | null>(null);

  const reset = useCallback(() => {
    currentPhraseRef.current = null;
    pendingIdentityRef.current = null;
    setProof(null);
  }, []);

  // Defense in depth: scrub the in-memory key material when the flow unmounts.
  useEffect(() => {
    return () => {
      currentPhraseRef.current = null;
      pendingIdentityRef.current = null;
    };
  }, []);

  return (
    <RotateKeyFlowContext.Provider
      value={{ proof, setProof, currentPhraseRef, pendingIdentityRef, reset }}
    >
      {children}
    </RotateKeyFlowContext.Provider>
  );
}

export function useRotateKeyFlow(): RotateKeyFlowValue {
  const context = useContext(RotateKeyFlowContext);
  if (!context) {
    throw new Error('useRotateKeyFlow must be used within RotateKeyFlowProvider');
  }
  return context;
}
