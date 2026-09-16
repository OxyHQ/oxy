import { useRef, useState } from 'react';
import { deriveIdentityFromMnemonic, type OpenedWebIdentity } from '@oxy.so/core';
import {
  confirmPhrase,
  deleteAccount,
  ensureIdentity,
  recoverWithPhrase,
  signIn,
  unlockIdentity,
  wipeIdentity,
  type CarrierSession,
  type IdentityState,
} from '../identity/carrier';
import { createPorts, messageOf } from '../identity/ports';
import { MoveFlow } from './MoveFlow';
import { PhraseScreen } from './PhraseScreen';

type View =
  | { name: 'signed-out' }
  | { name: 'working'; label: string }
  | { name: 'overview'; session: CarrierSession; identity: IdentityState }
  | { name: 'phrase'; session: CarrierSession; identity: OpenedWebIdentity }
  | { name: 'recover'; session: CarrierSession }
  | { name: 'delete'; session: CarrierSession }
  | { name: 'move'; session: CarrierSession }
  | { name: 'deleted' };

/**
 * `/` — your identity on the web.
 *
 * Everything that needs the identity key happens here, on this origin, with
 * this origin's own passkey session: saving the recovery phrase, recovering
 * with it, deleting the account. No other site ever receives the key or a
 * signature made with it.
 */
export function HomeScreen({ intent = 'overview' }: { intent?: 'overview' | 'move' }) {
  const portsRef = useRef(createPorts());
  const ports = portsRef.current;
  const [view, setView] = useState<View>({ name: 'signed-out' });
  const [error, setError] = useState<string | null>(null);
  const [phrase, setPhrase] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const intentRef = useRef(intent);

  function run(label: string, task: () => Promise<void>) {
    const from = view;
    setError(null);
    setView({ name: 'working', label });
    task().catch((reason: unknown) => {
      setError(messageOf(reason));
      setView(from);
    });
  }

  async function refresh(session: CarrierSession) {
    const identity = await ensureIdentity(ports, session);
    if (identity.kind === 'created') setView({ name: 'phrase', session, identity: identity.identity });
    else if (intentRef.current === 'move' && identity.kind === 'ready') setView({ name: 'move', session });
    else setView({ name: 'overview', session, identity });
    intentRef.current = 'overview';
  }

  const errorLine = error ? <p className="error">{error}</p> : null;

  switch (view.name) {
    case 'signed-out':
      return (
        <section className="card">
          <h1>Your Oxy identity</h1>
          <p>Your identity is yours. It is sealed with your passkey, and nobody — not even Oxy — can open it without you.</p>
          {errorLine}
          <div className="actions">
            <button type="button" className="primary" onClick={() => run('Waiting for your passkey…', async () => refresh(await signIn(ports)))}>
              Sign in with a passkey
            </button>
          </div>
        </section>
      );
    case 'working':
      return <p className="status">{view.label}</p>;
    case 'phrase':
      return (
        <PhraseScreen
          identity={view.identity}
          onConfirmed={async () => {
            await confirmPhrase(ports, view.session, view.identity);
            wipeIdentity(view.identity);
            await refresh(view.session);
          }}
          onLater={() => {
            wipeIdentity(view.identity);
            void refresh(view.session);
          }}
        />
      );
    case 'recover':
      return (
        <section className="card">
          <h1>Recover with your phrase</h1>
          <p>Type your 12 words. Your identity will be sealed again with the passkey you just used.</p>
          <textarea className="phrase-input" rows={3} autoCapitalize="none" autoComplete="off" spellCheck={false} value={phrase} onChange={(event) => setPhrase(event.target.value)} />
          {errorLine}
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={phrase.trim().split(/\s+/).length !== 12}
              onClick={() =>
                run('Recovering…', async () => {
                  const identity = deriveIdentityFromMnemonic(phrase);
                  setPhrase('');
                  try {
                    await recoverWithPhrase(ports, view.session, identity);
                  } finally {
                    wipeIdentity(identity);
                  }
                  await refresh(view.session);
                })
              }
            >
              Recover
            </button>
            <button type="button" className="link" onClick={() => void refresh(view.session)}>
              Back
            </button>
          </div>
        </section>
      );
    case 'delete':
      return (
        <section className="card danger">
          <h1>Delete your account</h1>
          <p>
            This permanently deletes <strong>@{view.session.account.username}</strong> and everything in it. It cannot be undone.
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
                  const identity = await unlockIdentity(ports, view.session);
                  try {
                    await deleteAccount(ports, identity, confirmText);
                  } finally {
                    wipeIdentity(identity);
                  }
                  await ports.local.remove(view.session.account.userId);
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
      const { session, identity } = view;
      return (
        <section className="card">
          <h1>@{session.account.username}</h1>
          <IdentitySummary identity={identity} />
          {errorLine}
          <div className="actions vertical">
            {identity.kind === 'ready' ? (
              <button
                type="button"
                className={identity.phraseConfirmedAt ? 'secondary' : 'primary'}
                onClick={() => run('Opening your identity…', async () => setView({ name: 'phrase', session, identity: await unlockIdentity(ports, session) }))}
              >
                {identity.phraseConfirmedAt ? 'Show my recovery phrase' : 'Save my recovery phrase'}
              </button>
            ) : null}
            {identity.kind === 'ready' ? (
              <button type="button" className="secondary" onClick={() => setView({ name: 'move', session })}>
                Move my identity to the Commons app
              </button>
            ) : null}
            {identity.kind === 'locked' || identity.kind === 'elsewhere' ? (
              <button type="button" className="secondary" onClick={() => setView({ name: 'recover', session })}>
                Recover with my phrase
              </button>
            ) : null}
            {identity.kind === 'ready' ? (
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

function IdentitySummary({ identity }: { identity: IdentityState }) {
  switch (identity.kind) {
    case 'ready':
      return identity.phraseConfirmedAt ? (
        <p>Your identity is kept in this browser, sealed with your passkey, and your recovery phrase is saved.</p>
      ) : (
        <p className="note">Your identity is sealed with your passkey, but your recovery phrase isn’t saved yet. Save it now — it is the only way back if you lose your passkeys.</p>
      );
    case 'elsewhere':
      return <p>Your identity lives in the Commons app. To keep it on the web as well, recover it here with your phrase.</p>;
    case 'locked':
      return <p className="note">This passkey can’t open your identity in this browser. Use another passkey, or recover with your phrase.</p>;
    case 'unsupported':
      return <p className="note">This browser can’t keep your identity. Use Safari, Chrome, or the Commons app.</p>;
    default:
      return null;
  }
}
