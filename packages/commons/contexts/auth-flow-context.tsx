import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

interface AuthFlowContextValue {
  error: string | null;
  isSigningIn: boolean;
  setAuthError: (error: string | null) => void;
  setSigningIn: (signingIn: boolean) => void;
  /**
   * Recovery phrase generated during identity creation. Held in a ref so it
   * survives navigation but is NEVER persisted to storage — by design, the
   * user must write it down before continuing and there is no second chance.
   *
   * Cleared (set to null) once the user explicitly acknowledges they have
   * saved it. Cleared on AuthFlowProvider unmount as a defense-in-depth
   * measure against accidental retention.
   */
  recoveryPhraseRef: React.MutableRefObject<string[] | null>;
  /** Marks the phrase as acknowledged by the user. */
  acknowledgeRecoveryPhrase: () => void;
  /** Whether the user has explicitly confirmed they saved the recovery phrase. */
  recoveryPhraseAcknowledged: boolean;
}

const AuthFlowContext = createContext<AuthFlowContextValue | undefined>(undefined);

/**
 * Provider for sharing auth flow state across screens
 */
export function AuthFlowProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [recoveryPhraseAcknowledged, setRecoveryPhraseAcknowledged] = useState(false);
  const recoveryPhraseRef = React.useRef<string[] | null>(null);

  // Defense in depth: scrub the in-memory phrase when the auth flow unmounts.
  // We never persist this value to AsyncStorage or SecureStore.
  React.useEffect(() => {
    return () => {
      recoveryPhraseRef.current = null;
    };
  }, []);

  const setAuthError = useCallback((errorMessage: string | null) => {
    setError(errorMessage);
  }, []);

  const setSigningIn = useCallback((signingIn: boolean) => {
    setIsSigningIn(signingIn);
  }, []);

  const acknowledgeRecoveryPhrase = useCallback(() => {
    setRecoveryPhraseAcknowledged(true);
    // Wipe the in-memory copy immediately — once acknowledged, no screen
    // should be re-reading it. The user must derive a new phrase via the
    // "view recovery phrase" settings screen instead.
    recoveryPhraseRef.current = null;
  }, []);

  return (
    <AuthFlowContext.Provider
      value={{
        error,
        isSigningIn,
        setAuthError,
        setSigningIn,
        recoveryPhraseRef,
        acknowledgeRecoveryPhrase,
        recoveryPhraseAcknowledged,
      }}
    >
      {children}
    </AuthFlowContext.Provider>
  );
}

/**
 * Hook to access auth flow context
 */
export function useAuthFlowContext(): AuthFlowContextValue {
  const context = useContext(AuthFlowContext);
  if (!context) {
    throw new Error('useAuthFlowContext must be used within AuthFlowProvider');
  }
  return context;
}
