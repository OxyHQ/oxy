import { useEffect, useRef, useState } from 'react';
import type { OpenedWebIdentity } from '@oxy.so/core';
import {
  confirmPhrase,
  deleteAccount,
  establishRoot,
  openRootForDisplay,
  readIdentityStatus,
  recoverSignedOut,
  resealFromMaterial,
  signIn,
  wipeIdentity,
  type CarrierSession,
  type IdentityStatus,
} from '../identity/carrier';
import { createPorts, messageOf } from '../identity/ports';
import { MoveFlow } from './MoveFlow';
import { PhraseScreen } from './PhraseScreen';
import { RecoveryForm } from './RecoveryForm';

type View =
  | { name: 'signed-out' }
  | { name: 'recover-signed-out' }
  | { name: 'working'; label: string }
  | { name: 'overview'; session: CarrierSession; status: IdentityStatus }
  | { name: 'phrase'; session: CarrierSession; identity: OpenedWebIdentity }
  | { name: 'recover'; session: CarrierSession }
  | { name: 'delete'; session: CarrierSession }
  | { name: 'move'; session: CarrierSession }
  | { name: 'deleted' };

/**
 * `/` — the person's Oxy identity: saving the recovery phrase, recovering,
 * giving it to Commons, deleting the account. Every one of these opens the root
 * with a fresh passkey ceremony, for that operation only; signing in opens nothing.
 */
export function HomeScreen({ intent = 'overview' }: { intent?: 'overview' | 'move' }) {
  const portsRef = useRef(createPorts());
  const ports = portsRef.current;
  const [view, setView] = useState<View>({ name: 'signed-out' });
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const intentRef = useRef(intent);

  // An opened root lives only while the phrase is on screen.
  const openRef = useRef<OpenedWebIdentity | null>(null);
  useEffect(() => {
    const previous = openRef.current;
    openRef.current = view.name === 'phrase' ? view.identity : null;
    if (previous && previous !== openRef.current) wipeIdentity(previous);
  }, [view]);
  useEffect(
    () => () => {
      if (openRef.current) wipeIdentity(openRef.current);
    },
    [],
  );

  function run(label: string, task: () => Promise<void>, from: View = view) {
    setError(null);
    setView({ name: 'working', label });
    task().catch((reason: unknown) => {
      setError(messageOf(reason));
      setView(from);
    });
  }

  async function refresh(session: CarrierSession) {
    const status = await readIdentityStatus(ports, session);
    if (intentRef.current === 'move' && status.kind === 'ready') setView({ name: 'move', session });
    else setView({ name: 'overview', session, status });
    intentRef.current = 'overview';
  }

  const errorLine = error ? <p className="error">{error}</p> : null;

  switch (view.name) {
    case 'signed-out':
      return (
        <section className="card">
          <h1>Your Oxy identity</h1>
          <p>Your identity is yours. It is protected with your passkey, and nobody — not even Oxy — can open it without you.</p>
          {errorLine}
          <div className="actions vertical">
            <button type="button" className="primary" onClick={() => run('Waiting for your passkey…', async () => refresh(await signIn(ports)))}>
              Sign in with a passkey
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setError(null);
                setView({ name: 'recover-signed-out' });
              }}
            >
              Lost your passkey? Recover your account
            </button>
          </div>
        </section>
      );
    case 'recover-signed-out':
      return (
        <RecoveryForm
          title="Recover your account"
          description="Type your recovery phrase. It stays on this device — it is used here to prove the account is yours, and then to protect it with a new passkey."
          submitLabel="Recover"
          error={error}
          onBack={() => setView({ name: 'signed-out' })}
          onSubmit={(material) => run('Recovering your account…', async () => refresh(await recoverSignedOut(ports, material)), { name: 'recover-signed-out' })}
        />
      );
    case 'working':
      return <p className="status">{view.label}</p>;
    case 'phrase':
      return (
        <PhraseScreen
          identity={view.identity}
          onConfirmed={async () => {
            await confirmPhrase(ports, view.session, view.identity);
            await refresh(view.session);
          }}
          onLater={() => void refresh(view.session)}
        />
      );
    case 'recover':
      return (
        <RecoveryForm
          title="Use your recovery phrase"
          description="Your identity will be protected again with the passkey you signed in with."
          submitLabel="Continue"
          error={error}
          onBack={() => void refresh(view.session)}
          onSubmit={(material) =>
            run(
              'Protecting your identity…',
              async () => {
                await resealFromMaterial(ports, view.session, material);
                await refresh(view.session);
              },
              { name: 'recover', session: view.session },
            )
          }
        />
      );
    case 'delete':
      return (
        <section className="card danger">
          <h1>Delete your account</h1>
          <p>
            This permanently deletes <strong>@{view.session.account.username}</strong> and everything in it. It cannot be undone.
            Copies of your data that were already shared with other services or exported are not reachable from here.
          </p>
          <label className="field">
            Type your username to confirm
            <input autoCapitalize="none" autoComplete="off" spellCheck={false} value={confirmText} onChange={(event) => setConfirmText(event.target.value)} />
          </label>
          {errorLine}
          <div className="actions">
            <button
              type="button"
              className="destructive"
              disabled={confirmText !== view.session.account.username}
              onClick={() =>
                run('Deleting your account…', async () => {
                  await deleteAccount(ports, view.session, confirmText);
                  setView({ name: 'deleted' });
                })
              }
            >
              Delete forever
            </button>
            <button type="button" className="link" onClick={() => void refresh(view.session)}>
              Cancel
            </button>
          </div>
        </section>
      );
    case 'move':
      return <MoveFlow ports={ports} session={view.session} onDone={() => run('Loading…', () => refresh(view.session))} />;
    case 'deleted':
      return (
        <section className="card">
          <h1>Your account was deleted</h1>
          <p>You can close this window.</p>
        </section>
      );
    case 'overview': {
      const { session, status } = view;
      return (
        <section className="card">
          <h1>@{session.account.username}</h1>
          <StatusSummary status={status} />
          {errorLine}
          <div className="actions vertical">
            {status.kind === 'ready' && status.hasPhrase ? (
              <button
                type="button"
                className={status.phraseConfirmedAt ? 'secondary' : 'primary'}
                onClick={() => run('Opening your identity…', async () => setView({ name: 'phrase', session, identity: await openRootForDisplay(ports, session) }))}
              >
                {status.phraseConfirmedAt ? 'Show my recovery phrase' : 'Save my recovery phrase'}
              </button>
            ) : null}
            {status.kind === 'ready' && status.hasPhrase ? (
              <button type="button" className="secondary" onClick={() => setView({ name: 'move', session })}>
                Add my identity to the Commons app
              </button>
            ) : null}
            {status.kind === 'no-root' ? (
              <button
                type="button"
                className="primary"
                onClick={() =>
                  run('Creating your identity…', async () => {
                    const { identity } = await establishRoot(ports, session);
                    setView({ name: 'phrase', session, identity });
                  })
                }
              >
                Secure my account
              </button>
            ) : null}
            <button type="button" className="secondary" onClick={() => setView({ name: 'recover', session })}>
              {status.kind === 'elsewhere' ? 'Keep my identity in this browser too' : 'Use my recovery phrase'}
            </button>
            {status.kind === 'ready' ? (
              <button type="button" className="link destructive-link" onClick={() => setView({ name: 'delete', session })}>
                Delete my account
              </button>
            ) : null}
          </div>
        </section>
      );
    }
  }
}

function StatusSummary({ status }: { status: IdentityStatus }) {
  switch (status.kind) {
    case 'ready':
      if (!status.hasPhrase) return <p>Your identity is kept in this browser, protected with your passkey.</p>;
      return status.phraseConfirmedAt ? (
        <p>Your identity is kept in this browser, protected with your passkey, and your recovery phrase is saved.</p>
      ) : (
        <p className="note">Your identity is protected with your passkey, but your recovery phrase isn’t saved yet. Save it now — it is the only way back if you lose your passkeys.</p>
      );
    case 'elsewhere':
      return <p>Your identity is kept in the Commons app. To keep it in this browser as well, use your recovery phrase.</p>;
    case 'no-root':
      return <p className="note">Your account doesn’t have its own identity yet. Secure it with your passkey to get a recovery phrase only you keep.</p>;
  }
}
