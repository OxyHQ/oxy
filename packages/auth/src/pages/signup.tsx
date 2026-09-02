import { useSearchParams } from "react-router-dom";
import { SignUpForm } from "@/components/sign-up-form";

export function SignUpPage() {
  const [searchParams] = useSearchParams();

  return (
    <SignUpForm
      error={searchParams.get("error") ?? undefined}
      sessionToken={searchParams.get("token") ?? undefined}
      redirectUri={searchParams.get("redirect_uri") ?? undefined}
      state={searchParams.get("state") ?? undefined}
      clientId={searchParams.get("client_id") ?? undefined}
      codeChallenge={searchParams.get("code_challenge") ?? undefined}
      codeChallengeMethod={searchParams.get("code_challenge_method") ?? undefined}
      scope={searchParams.get("scope") ?? undefined}
      resource={searchParams.get("resource") ?? undefined}
      responseType={searchParams.get("response_type") ?? undefined}
      responseMode={searchParams.get("response_mode") ?? undefined}
    />
  );
}
