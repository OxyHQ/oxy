import { useEffect, useRef, useState } from 'react';
import type { CommonsApprovalInfo, OpenedWebIdentity } from '@oxy.so/core';
import {
  confirmPhrase,
  establishRoot,
  readIdentityStatus,
  recoverSignedOut,
  signIn,
  signUp,
  wipeIdentity,
  type CarrierSession,
  type IdentityStatus,
} from '../identity/carrier';
import { createPorts, messageOf } from '../identity/ports';
import { PhraseScreen } from './PhraseScreen';
import { RecoveryForm } from './RecoveryForm';

type Stage =
  | { name: 'loading' }
  | { name: 'blocked'; message: string }
  | { name: 'start' }
  | { name: 'recover' }
  | { name: 'working'; label: string }
  | { name: 'secure'; session: CarrierSession }
  | { name: 'phrase'; session: CarrierSession; identity: OpenedWebIdentity }
  | { name: 'confirm'; session: CarrierSession; status: IdentityStatus | null; recovered?: boolean }
  | { name: 'done' };

/**
 * `/continue?code=…` — sign in to the app that opened this window.
 *
 * The app created a device-flow request and opened this page with its authorize
 * code; this page signs the person in with a passkey — creating the account WITH
 * its root, or recovering it from the recovery phrase — and then authorizes THAT
 * request, which the app claims through its existing poll/socket.
 *
 * Signing in opens nothing (ADR 0024 D3): the note about the account's identity
 * comes from metadata. A root is opened only to create one, to confirm the phrase,
 * or when a legacy account without one chooses to finish securing itself.
 *
 * SECURITY — the authorize call fires ONLY from an explicit press on a screen
 * naming the application and the account, behind an unchecked-by-default
 * acknowledgement, so a crafted code from an attacker's own app cannot be
 * authorized by a single tap.
 */
export function ContinueScreen({ code }: { code: string }) {
  const portsRef = useRef(createPorts());
  const ports = portsRef.current;
  const [approval, setApproval] = useState<CommonsApprovalInfo | null>(null);
  const [stage, setStage] = useState<Stage>({ name: 'loading' });
  const [username, setUsername] = useState('');
  const [creating, setCreating] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasOpener = typeof window !== 'undefined' && window.opener != null;

  // An opened root lives only while its screen is visible.
  const openRef = useRef<OpenedWebIdentity | null>(null);
  useEffect(() => {
    const previous = openRef.current;
    openRef.current = stage.name === 'phrase' ? stage.identity : null;
    if (previous && previous !== openRef.current) wipeIdentity(previous);
  }, [stage]);
  useEffect(
    () => () => {
      if (openRef.current) wipeIdentity(openRef.current);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    ports.api
      .approvalInfo(code)
      .then(({ info, blockingReason }) => {
        if (cancelled) return;
        if (blockingReason) setStage({ name: 'blocked', message: blockingReason });
        else {
          setApproval(info);
          setStage({ name: 'start' });
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setStage({ name: 'blocked', message: messageOf(reason) });
      });
    return () => {
      cancelled = true;
    };
  }, [code, ports]);

  async function afterSignIn(session: CarrierSession) {
    setStage({ name: 'working', label: 'Signing you in…' });
    const status = await readIdentityStatus(ports, session);
    if (status.kind === 'no-root') {
      setStage({ name: 'secure', session });
      return;
    }
    setStage({ name: 'confirm', session, status });
  }

  /** Run a step; on failure return to the stage it started from, with the reason shown. */
  function run(label: string, task: () => Promise<void>, from: Stage = stage) {
    setError(null);
    setStage({ name: 'working', label });
    task().catch((reason: unknown) => {
      setError(messageOf(reason));
      setStage(from);
    });
  }

  function cancel() {
    void ports.api.denyCode(code).catch(() => undefined);
    window.close();
  }

  if (!hasOpener) {
    return (
      <section className="card">
        <h1>Can’t open this here</h1>
        <p>Open this page from the app that asked you to sign in.</p>
      </section>
    );
  }

  switch (stage.name) {
    case 'loading':
      return <p className="status">Loading…</p>;
    case 'blocked':
      return (
        <section className="card">
          <h1>This sign-in request can’t be used</h1>
          <p>{stage.message}</p>
        </section>
      );
    case 'working':
      return <p className="status">{stage.label}</p>;
    case 'recover':
      return (
        <RecoveryForm
          title="Recover your account"
          description="Type your recovery phrase. It stays on this device — it is used here to prove the account is yours, and then to protect it with a new passkey."
          submitLabel="Recover"
          error={error}
          onBack={() => {
            setError(null);
            setStage({ name: 'start' });
          }}
          onSubmit={(material) =>
            run(
              'Recovering your account…',
              async () => {
                const session = await recoverSignedOut(ports, material);
                const status = await readIdentityStatus(ports, session);
                setStage({ name: 'confirm', session, status, recovered: true });
              },
              { name: 'recover' },
            )
          }
        />
      );
    case 'secure':
      return (
        <section className="card">
          <h1>Finish securing your account</h1>
          <p>
            Your account doesn’t have its own identity yet. Create it now with your passkey — you’ll get a recovery phrase
            that only you keep.
          </p>
          {error ? <p className="error">{error}</p> : null}
          <div className="actions vertical">
            <button
              type="button"
              className="primary"
              onClick={() =>
                run('Creating your identity…', async () => {
                  const { identity } = await establishRoot(ports, stage.session);
                  setStage({ name: 'phrase', session: stage.session, identity });
                })
              }
            >
              Secure my account
            </button>
            <button type="button" className="link" onClick={() => setStage({ name: 'confirm', session: stage.session, status: { kind: 'no-root' } })}>
              Not now
            </button>
          </div>
        </section>
      );
    case 'phrase':
      return (
        <PhraseScreen
          identity={stage.identity}
          onConfirmed={async () => {
            const status = await confirmPhrase(ports, stage.session, stage.identity);
            setStage({ name: 'confirm', session: stage.session, status });
          }}
          onLater={() => {
            void readIdentityStatus(ports, stage.session)
              .then((status) => setStage({ name: 'confirm', session: stage.session, status }))
              .catch(() => setStage({ name: 'confirm', session: stage.session, status: null }));
          }}
        />
      );
    case 'confirm': {
      const application = approval?.application;
      const account = stage.session.account;
      return (
        <section className="card">
          <h1>Sign in to {application?.name ?? 'this app'}?</h1>
          <p>
            You’ll be signed in as <strong>@{account.username ?? account.userId}</strong>.
          </p>
          {stage.recovered ? <p>Your account is recovered and protected with your new passkey.</p> : null}
          <IdentityNote status={stage.status} />
          <label className="check">
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
            {approval?.originVerified
              ? `I started this sign-in on ${application?.name ?? 'this app'}.`
              : 'I started this sign-in myself. This request’s origin could not be verified — if you didn’t start it, cancel.'}
          </label>
          {error ? <p className="error">{error}</p> : null}
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={!acknowledged}
              onClick={() =>
                run('Signing you in…', async () => {
                  await ports.api.authorizeCode(code);
                  await ports.api.signOut(account.sessionId).catch(() => undefined);
                  setStage({ name: 'done' });
                  window.setTimeout(() => window.close(), 800);
                })
              }
            >
              Continue
            </button>
            <button type="button" className="link" onClick={cancel}>
              Cancel
            </button>
          </div>
        </section>
      );
    }
    case 'done':
      return (
        <section className="card">
          <h1>You’re signed in</h1>
          <p>You can close this window.</p>
        </section>
      );
    default:
      return (
        <section className="card">
          <h1>Continue to {approval?.application?.name ?? 'the app'}</h1>
          <p>Use your passkey — your fingerprint, face or device PIN.</p>
          {error ? <p className="error">{error}</p> : null}
          <div className="actions">
            <button type="button" className="primary" onClick={() => run('Waiting for your passkey…', async () => afterSignIn(await signIn(ports)))}>
              Continue with a passkey
            </button>
          </div>
          {creating ? (
            <form
              className="create"
              onSubmit={(event) => {
                event.preventDefault();
                const handle = username.trim();
                if (!handle) return;
                run('Creating your account…', async () => {
                  if (!(await ports.api.isUsernameAvailable(handle))) throw new Error('That username is taken.');
                  const { session, identity } = await signUp(ports, handle);
                  setStage({ name: 'phrase', session, identity });
                });
              }}
            >
              <label className="field">
                Choose a username
                <input autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(event) => setUsername(event.target.value)} />
              </label>
              <button type="submit" className="primary" disabled={username.trim().length < 3}>
                Create account
              </button>
            </form>
          ) : (
            <button type="button" className="link" onClick={() => setCreating(true)}>
              New here? Create an account
            </button>
          )}
          <button
            type="button"
            className="link"
            onClick={() => {
              setError(null);
              setStage({ name: 'recover' });
            }}
          >
            Lost your passkey? Recover your account
          </button>
          <button type="button" className="link" onClick={cancel}>
            Cancel
          </button>
        </section>
      );
  }
}

function IdentityNote({ status }: { status: IdentityStatus | null }) {
  if (!status) return null;
  switch (status.kind) {
    case 'ready':
      return status.hasPhrase && !status.phraseConfirmedAt ? (
        <p className="note">Your recovery phrase isn’t saved yet. Save it from your Oxy account’s security settings — it’s the only way back if you lose your passkeys.</p>
      ) : null;
    case 'elsewhere':
      return <p className="note">Your identity is kept in the Commons app.</p>;
    case 'no-root':
      return <p className="note">Your account isn’t fully secured yet. You can finish next time you sign in.</p>;
  }
}
