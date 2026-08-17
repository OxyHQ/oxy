import { Link, createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import type { InferenceMessage } from '@oxyhq/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { PlaygroundRunReceipt } from '@/components/playground/playground-receipt';
import { accountLabel, useAccount } from '@/hooks/use-account';
import { useApplicationCredentials, useApplications, useCallerAccess } from '@/hooks/use-applications';
import { useModelCatalogue } from '@/hooks/use-models';
import { usePlaygroundReceipt, usePlaygroundRun } from '@/hooks/use-playground';
import { usePlaygroundKey } from '@/lib/playground-key';

export const Route = createFileRoute('/_layout/playground')({
  component: PlaygroundPage,
});

/**
 * The playground: one real request to the public inference edge (issue #972,
 * workstreams 4 and 9).
 *
 * ## Where the credential comes from, and the option that was rejected
 *
 * The edge authenticates an `oxy_sk_…` machine credential or a verified service
 * token, and NOTHING else (ADR 0010). A Console user's device-first session
 * bearer is not a principal of that lane, and Console cannot recover a credential
 * secret it once displayed — the API returns it exactly once and stores only its
 * hash. So the key has to be supplied, and there were three ways to do it:
 *
 *  - **A. The user pastes one.** Implemented. It lives in memory for this browser
 *    session and never touches storage, a cache, a query key or a URL.
 *  - **B. Offered at the moment of creation**, when `useCreateCredential` /
 *    `useRotateCredential` return the one-time secret. Implemented, and it is the
 *    SAME code path as A — see `lib/playground-key.ts`, which is why there are not
 *    two ways for a key to reach this screen.
 *  - **C. A Console-only server endpoint** that takes the user's session bearer
 *    plus `{applicationId, credentialId}` and invokes the edge server-side.
 *    **REJECTED.** It has the best UX and it re-introduces an ambient-session lane
 *    onto the inference path, which is exactly what ADR 0010 pushed out. Anything
 *    that can call the edge on the strength of a browser session is a confused
 *    deputy for every application the session can read. Not to be built without a
 *    new ADR that overturns 0010.
 *
 * ## Why the environment is not a picker
 *
 * An environment is a PROPERTY of the credential (`inferenceEdge.service.ts`
 * resolves it from the credential row), so the select below shows it and does not
 * offer it. Two controls that can disagree about which environment a request runs
 * in is a bug with a UI.
 *
 * ## What it will actually answer today
 *
 * No data plane is configured, so a real, correctly authenticated request is
 * admitted, has its spend reserved, finds no route to forward to, has the hold
 * released and comes back `service_unavailable`. `InferenceAvailabilityNotice`
 * says so BEFORE the button is pressed rather than after.
 */
function PlaygroundPage() {
  const { currentAccount } = useAccount();
  const { data: applications = [], isLoading: isLoadingApps } = useApplications();
  const { data: catalogue = [] } = useModelCatalogue();

  // The key is the store's, so the "try this key in the playground" hand-off from
  // a freshly created credential and a paste here are one path.
  const apiKey = usePlaygroundKey((state) => state.apiKey);
  const setApiKey = usePlaygroundKey((state) => state.setApiKey);

  const [applicationId, setApplicationId] = useState<string | null>(null);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [input, setInput] = useState('');

  const run = usePlaygroundRun();
  const receipt = usePlaygroundReceipt();

  // Every selection is DERIVED against the loaded data rather than synced into
  // state by an effect. That is what makes switching application safe: a
  // credential id from the previous application is simply not found in the new
  // list, so the fallback picks the new application's first key instead of
  // leaving a stale selection pointing at another app.
  //
  // `.at(0)` rather than `[0]`, throughout. This tsconfig has no
  // `noUncheckedIndexedAccess`, so `applications[0]` is typed `Application` while
  // being `undefined` at runtime for an empty list — which makes every guard below
  // look dead to the compiler and to the linter, and makes the one place the guard
  // is missing invisible. `.at()` is typed `| undefined`, so the types say what
  // actually happens.
  const application =
    applications.find((candidate) => candidate._id === applicationId) ?? applications.at(0);
  const access = useCallerAccess(application);
  const canReadCredentials = access.can('credentials:read');

  const { data: credentials = [] } = useApplicationCredentials(
    application?._id ?? '',
    application !== undefined && canReadCredentials
  );

  // Only a `machine` credential can authenticate the edge, and only an active one
  // resolves. Offering a revoked key would produce a refusal the user cannot act
  // on.
  const machineCredentials = credentials.filter(
    (candidate) => candidate.type === 'machine' && candidate.status === 'active'
  );
  const credential =
    machineCredentials.find((candidate) => candidate._id === credentialId) ??
    machineCredentials.at(0);

  const selectedModel =
    catalogue.find((candidate) => candidate.modelId === model)?.modelId ??
    catalogue.at(0)?.modelId;

  /**
   * Does the pasted key belong to the credential that is selected?
   *
   * `tokenPrefix` is the PUBLIC half of a machine token — `oxy_sk_<16 hex>` — and
   * the full bearer is `<prefix>_<64 hex>`, so this is an exact, offline check
   * against a value the API already serves. It is worth making: the selected
   * credential is what tells the user which ENVIRONMENT the request will run in,
   * and pasting a production key while a development credential is selected would
   * make that label a lie. Nothing is validated about the secret half here —
   * only the server can do that.
   */
  const keyMatchesCredential =
    apiKey.trim() === '' || credential?.tokenPrefix === undefined
      ? undefined
      : apiKey.trim().startsWith(`${credential.tokenPrefix}_`);

  const canRun =
    apiKey.trim() !== '' && selectedModel !== undefined && input.trim() !== '' && !run.isPending;

  const result = run.data;
  const completed = result?.status === 'completed' ? result.run : undefined;

  const handleRun = () => {
    if (selectedModel === undefined) {
      return;
    }
    // A new run invalidates the previous receipt: it belonged to another request
    // id, and leaving it on screen would attribute one run's charge to another.
    receipt.reset();
    run.mutate({ apiKey: apiKey.trim(), model: selectedModel, input: input.trim() });
  };

  return (
    <ScrollArea className="flex-1 bg-background">
      <div className="px-6 py-6 border-b border-border">
        <h1 className="text-2xl font-semibold text-foreground">Playground</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Try the inference API from the browser
        </p>
      </div>

      <div className="px-6 py-6 space-y-6 max-w-3xl">
        {/*
          Kept at the top, ahead of every control. A run costs the user a real
          request against a real credential and today it cannot succeed; saying so
          after the click would waste it.
        */}
        <InferenceAvailabilityNotice />

        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Request</h2>
            <p className="text-sm text-muted-foreground">
              The account is the one selected in the sidebar. The environment comes from the
              credential, so there is nothing to choose twice.
            </p>
          </div>

          {/*
            Read-only, deliberately. Account selection is global to this Console and
            every account-derived permission follows it; a second account picker on
            this screen could disagree with the one in the sidebar.
          */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Account</Label>
            <p className="text-sm text-foreground">
              {currentAccount === null ? 'No account selected' : accountLabel(currentAccount)}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="playground-app" className="text-xs text-muted-foreground">
              Application
            </Label>
            {isLoadingApps ? (
              <p className="text-sm text-muted-foreground">Loading applications…</p>
            ) : applications.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This account owns no applications yet.{' '}
                <Link to="/apps" className="text-primary hover:underline">
                  Create one
                </Link>
                .
              </p>
            ) : (
              <Select
                value={application?._id ?? ''}
                onValueChange={(value) => {
                  setApplicationId(value);
                  // Cleared rather than remapped: the credentials of the new
                  // application have not loaded yet, so there is no id here that
                  // could be correct.
                  setCredentialId(null);
                }}
              >
                <SelectTrigger id="playground-app">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {applications.map((candidate) => (
                    <SelectItem key={candidate._id} value={candidate._id}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="playground-credential" className="text-xs text-muted-foreground">
              Credential
            </Label>
            {!canReadCredentials ? (
              <p className="text-sm text-muted-foreground">
                You do not have permission to list this application's credentials. You can still
                paste a key below.
              </p>
            ) : machineCredentials.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This application has no active API key.{' '}
                {application !== undefined && (
                  <Link
                    to="/apps/$appId/settings"
                    params={{ appId: application._id }}
                    className="text-primary hover:underline"
                  >
                    Create one
                  </Link>
                )}
              </p>
            ) : (
              <>
                <Select
                  value={credential?._id ?? ''}
                  onValueChange={(value) => setCredentialId(value)}
                >
                  <SelectTrigger id="playground-credential">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {machineCredentials.map((candidate) => (
                      <SelectItem key={candidate._id} value={candidate._id}>
                        {candidate.name} · {candidate.environment}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {credential !== undefined && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Badge variant="ghost" className="text-xs capitalize">
                      {credential.environment}
                    </Badge>
                    {credential.tokenPrefix !== undefined && (
                      <span className="text-xs font-mono text-muted-foreground">
                        {credential.tokenPrefix}
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/*
            The secret itself. `type="password"` and `autoComplete="off"`: this is a
            bearer token, and a browser password manager offering to save it would
            put it exactly where it must not go.
          */}
          <div className="space-y-1.5">
            <Label htmlFor="playground-key" className="text-xs text-muted-foreground">
              API key
            </Label>
            <div className="flex gap-2">
              <Input
                id="playground-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="oxy_sk_…"
              />
              {apiKey !== '' && (
                <Button variant="outline" onClick={() => setApiKey('')}>
                  Forget
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Held in this tab's memory only — never stored, never cached, and gone when you
              reload. Oxy cannot show you a key again after it is created, so paste it here or
              start from a freshly created credential.
            </p>
            {keyMatchesCredential === false && (
              <p className="text-xs text-yellow-600 dark:text-yellow-500">
                This key does not belong to the selected credential, so it may run in a
                different environment than the one shown above.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="playground-model" className="text-xs text-muted-foreground">
              Model
            </Label>
            {catalogue.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                The catalogue is empty, so there is no model to call.{' '}
                <Link to="/models" className="text-primary hover:underline">
                  See the catalogue
                </Link>
                .
              </p>
            ) : (
              <Select value={selectedModel ?? ''} onValueChange={(value) => setModel(value)}>
                <SelectTrigger id="playground-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {catalogue.map((entry) => (
                    <SelectItem key={entry.modelId} value={entry.modelId}>
                      {entry.displayName} · {entry.modelId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="playground-input" className="text-xs text-muted-foreground">
              Input
            </Label>
            <Textarea
              id="playground-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={5}
              placeholder="Ask the model something"
            />
          </div>

          <Button onClick={handleRun} disabled={!canRun}>
            {run.isPending ? 'Running…' : 'Run'}
          </Button>
        </section>

        {/*
          A transport failure — no network, DNS, a blocked request. There is no
          server answer and therefore no request id to report, which is exactly why
          this is separate from a refusal.
        */}
        {run.isError && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 p-3">
            <HugeiconsIcon icon={Alert02Icon} size={16} className="mt-0.5 text-destructive" />
            <div>
              <p className="text-sm font-medium text-destructive">The request did not complete</p>
              <p className="text-sm text-muted-foreground">
                {run.error instanceof Error ? run.error.message : 'The request failed.'}
              </p>
            </div>
          </div>
        )}

        {/*
          A refusal from the edge, which is a real answer and is rendered as one:
          the closed error code, whether an identical retry could ever succeed, and
          the request id — without which the user has nothing to quote when
          reporting it.
        */}
        {result?.status === 'refused' && (
          <div className="space-y-2 rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-foreground">Request refused</p>
              <Badge variant="outline" className="text-xs font-mono">
                {result.error.code}
              </Badge>
              <Badge variant="ghost" className="text-xs">
                {result.error.retryable ? 'retryable' : 'not retryable'}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{result.error.message}</p>
            <p className="text-xs font-mono text-muted-foreground">
              Request ID {result.error.requestId}
            </p>
          </div>
        )}

        {completed !== undefined && (
          <>
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-foreground">Output</h2>
              <div className="rounded-lg border border-border p-4 space-y-3">
                {completed.output.map((message, index) => (
                  <OutputMessage key={index} message={message} />
                ))}
              </div>
            </section>

            <PlaygroundRunReceipt
              run={completed}
              receipt={receipt.data}
              isFetchingReceipt={receipt.isPending}
              onFetchReceipt={() =>
                receipt.mutate({ apiKey: apiKey.trim(), requestId: completed.requestId })
              }
              receiptError={
                receipt.error instanceof Error ? receipt.error.message : undefined
              }
            />
          </>
        )}

        <Link
          to="/documentation/chat-completions"
          className="flex items-center gap-1 text-sm text-primary hover:underline"
        >
          Read the Chat Completions reference
          <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
        </Link>
      </div>
    </ScrollArea>
  );
}

/**
 * One message of the normalized output.
 *
 * A message's content is always a LIST of parts, and only the `text` parts have
 * anything to print. An image or audio part is named rather than rendered — the
 * playground is not a media viewer, and silently dropping a part would make a
 * multimodal answer look truncated.
 */
function OutputMessage({ message }: { message: InferenceMessage }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground capitalize">{message.role}</p>
      {message.content.map((part, index) =>
        part.type === 'text' ? (
          <p key={index} className="text-sm text-foreground whitespace-pre-wrap">
            {part.text}
          </p>
        ) : (
          <Badge key={index} variant="outline" className="text-xs">
            {part.type} content
          </Badge>
        )
      )}
      {message.toolCalls?.map((call) => (
        <div key={call.id} className="rounded border border-border p-2">
          <p className="text-xs font-mono text-foreground">{call.name}</p>
          <p className="text-xs font-mono text-muted-foreground whitespace-pre-wrap">
            {call.arguments}
          </p>
        </div>
      ))}
    </div>
  );
}
