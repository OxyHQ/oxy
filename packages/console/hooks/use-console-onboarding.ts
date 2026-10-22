import { useAuth } from '@oxy.so/services/ui/client';
import type { ConsoleOnboardingState } from '@oxy.so/contracts';
import { CONSOLE_TERMS_VERSION, type ConsoleUseCaseId } from '@oxy.so/contracts/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * The signed-in person's first-run state (terms + use-case answers). It belongs to the
 * person, not the workspace, so the key is the user id. Both mutations answer with the new
 * state, which replaces the cached one: the gate re-derives its step from it, nothing is
 * stored client-side.
 */
export function useConsoleOnboarding() {
  const { oxyServices, isAuthenticated, isReady, user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ['console-onboarding', user?.id ?? null] as const;

  const query = useQuery({
    queryKey,
    queryFn: () => oxyServices.console.onboarding.get(),
    enabled: isReady && isAuthenticated && !!user?.id,
    staleTime: 1000 * 60 * 10,
    retry: 1,
  });

  const store = (state: ConsoleOnboardingState) => queryClient.setQueryData(queryKey, state);

  const acceptTerms = useMutation({
    mutationFn: (input: { marketingOptIn: boolean }) =>
      oxyServices.console.onboarding.acceptTerms({
        version: CONSOLE_TERMS_VERSION,
        adultAcknowledged: true,
        aupAcknowledged: true,
        marketingOptIn: input.marketingOptIn,
      }),
    onSuccess: store,
  });

  const saveUseCases = useMutation({
    mutationFn: (input: { useCases: ConsoleUseCaseId[]; description?: string }) =>
      oxyServices.console.onboarding.saveUseCases(input),
    onSuccess: store,
  });

  return { query, acceptTerms, saveUseCases };
}
