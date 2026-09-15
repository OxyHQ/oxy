import { useEffect, useRef, useState } from 'react';
import type { CommonsApprovalInfo, OpenedWebIdentity } from '@oxy.so/core';
import { confirmPhrase, ensureIdentity, signIn, signUp, wipeIdentity, type CarrierSession, type IdentityState } from '../identity/carrier';
import { createPorts, messageOf } from '../identity/ports';
import { PhraseScreen } from './PhraseScreen';

/** What the confirmation screen says about the identity — nothing more is needed there. */
type IdentityNoteKind = 'saved' | 'phrase-unsaved' | 'elsewhere' | 'locked' | 'unsupported';

function noteFor(identity: IdentityState): IdentityNoteKind {
  switch (identity.kind) {
    case 'ready':
      return identity.phraseConfirmedAt ? 'saved' : 'phrase-unsaved';
    case 'created':
      return 'phrase-unsaved';
    default:
      return identity.kind;
  }
}

type Stage =
  | { name: 'loading' }
  | { name: 'blocked'; message: string }
  | { name: 'start' }
  | { name: 'working'; label: string }
  | { name: 'phrase'; session: CarrierSession; identity: OpenedWebIdentity }
  | { name: 'confirm'; session: CarrierSession; note: IdentityNoteKind }
  | { name: 'done' };

/**
 * `/continue?code=…` — sign in to the app that opened this popup.
 *
 * The app created a device-flow request and opened this origin with its
 * authorize code; this page signs the person in with a passkey (creating the
 * account and its identity if needed) and then authorizes THAT request, which
 * the app claims through its existing poll/socket.
 *
 * SECURITY — the same rules as the passkey hub it succeeds
 * (`packages/auth/src/pages/hub-passkey.tsx`): signing in here only plants a
 * bearer on THIS origin; the authorize call fires ONLY from an explicit press on
 * a screen naming the application and the account, behind an unchecked-by-
 * default acknowledgement. A crafted code from an attacker's own app therefore
 * cannot be authorized by a single tap.
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
    setStage({ name: 'working', label: 'Preparing your identity…' });
    const identity = await ensureIdentity(ports, session);
    if (identity.kind === 'created') {
      setStage({ name: 'phrase', session, identity: identity.identity });
      return;
    }
    setStage({ name: 'confirm', session, note: noteFor(identity) });
  }

  /** Run a step; on failure return to the stage it started from, with the reason shown. */
  function run(label: string, task: () => Promise<void>) {
    const from = stage;
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
    case 'phrase':
      return (
        <PhraseScreen
          identity={stage.identity}
          onConfirmed={async () => {
            await confirmPhrase(ports, stage.session, stage.identity);
            wipeIdentity(stage.identity);
            setStage({ name: 'confirm', session: stage.session, note: 'saved' });
          }}
          onLater={() => {
            wipeIdentity(stage.identity);
            setStage({ name: 'confirm', session: stage.session, note: 'phrase-unsaved' });
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
          <IdentityNote note={stage.note} />
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
                  await afterSignIn(await signUp(ports, handle));
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
          <button type="button" className="link" onClick={cancel}>
            Cancel
          </button>
        </section>
      );
  }
}

function IdentityNote({ note }: { note: IdentityNoteKind }) {
  switch (note) {
    case 'phrase-unsaved':
      return <p className="note">Your recovery phrase isn’t saved yet. Open id.oxy.so to save it.</p>;
    case 'elsewhere':
      return <p className="note">Your identity lives in the Commons app.</p>;
    case 'locked':
      return <p className="note">This passkey can’t open your identity here. You can recover it with your phrase at id.oxy.so.</p>;
    case 'unsupported':
      return <p className="note">This browser can’t keep your identity. Use Safari, Chrome, or the Commons app to keep it.</p>;
    default:
      return null;
  }
}
