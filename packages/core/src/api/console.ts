/**
 * `oxy.console` — Oxy Console first-run onboarding.
 *
 * `oxy.console.onboarding` reads and writes the signed-in person's terms
 * acceptance and use-case answers. They belong to the person, not to a
 * workspace. Wire types live in `@oxy.so/contracts` (`consoleOnboarding.ts`);
 * the current terms version and the use-case ids are `CONSOLE_TERMS_VERSION`
 * and `CONSOLE_USE_CASES` from `@oxy.so/contracts/client`.
 */
import type {
  AcceptConsoleTermsInput,
  ConsoleOnboardingState,
  SaveConsoleUseCasesInput,
} from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';

export class ConsoleOnboardingApi {
  constructor(protected readonly ctx: OxyContext) {}

  /** The person's onboarding state; a person with no record gets the empty state. */
  async get(): Promise<ConsoleOnboardingState> {
    return this.ctx.request<ConsoleOnboardingState>('GET', '/console/onboarding', undefined, {
      cache: false,
    });
  }

  /** Accept the current terms. Refused with 409 when `version` is not current. */
  async acceptTerms(input: AcceptConsoleTermsInput): Promise<ConsoleOnboardingState> {
    return this.ctx.request<ConsoleOnboardingState>('POST', '/console/onboarding/terms', input, {
      cache: false,
    });
  }

  /** Save the use cases (empty list = skip). Refused with 409 until the terms are accepted. */
  async saveUseCases(input: SaveConsoleUseCasesInput): Promise<ConsoleOnboardingState> {
    return this.ctx.request<ConsoleOnboardingState>(
      'POST',
      '/console/onboarding/use-cases',
      input,
      { cache: false },
    );
  }
}

export class ConsoleApi {
  readonly onboarding: ConsoleOnboardingApi;

  constructor(ctx: OxyContext) {
    this.onboarding = new ConsoleOnboardingApi(ctx);
  }
}
