import { useMemo, useState } from 'react';
import type { OpenedWebIdentity } from '@oxy.so/core';
import { pickConfirmationPositions } from '../identity/carrier';

interface PhraseScreenProps {
  identity: OpenedWebIdentity;
  /** Called after the person typed back the requested words. */
  onConfirmed: () => Promise<void>;
  /** Present only where leaving it for later is allowed. */
  onLater?: () => void;
}

/**
 * Show the 12-word recovery phrase, then ask for three of the words back.
 *
 * "I saved it" is demonstrated, not clicked: the phrase is the only way to get
 * an identity back when every device and passkey is gone, and nobody — Oxy
 * included — can reset it.
 */
export function PhraseScreen({ identity, onConfirmed, onLater }: PhraseScreenProps) {
  const words = useMemo(() => identity.mnemonic.split(' '), [identity.mnemonic]);
  const positions = useMemo(() => pickConfirmationPositions(words.length), [words.length]);
  const [step, setStep] = useState<'show' | 'check'>('show');
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const correct = positions.every((position) => (answers[position] ?? '').trim().toLowerCase() === words[position]);

  if (step === 'show') {
    return (
      <section className="card">
        <h1>Your recovery phrase</h1>
        <p>
          These 12 words are your identity. Write them down and keep them somewhere safe. If you lose every device
          and passkey, they are the only way back — nobody, not even Oxy, can reset them.
        </p>
        <ol className="phrase">
          {words.map((word, index) => (
            <li key={`${index}-${word}`}>{word}</li>
          ))}
        </ol>
        <div className="actions">
          <button type="button" className="primary" onClick={() => setStep('check')}>
            I wrote them down
          </button>
          {onLater ? (
            <button type="button" className="link" onClick={onLater}>
              Later
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <h1>Check your phrase</h1>
      <p>Type these words from your recovery phrase.</p>
      {positions.map((position) => (
        <label key={position} className="field">
          Word #{position + 1}
          <input
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={answers[position] ?? ''}
            onChange={(event) => setAnswers((current) => ({ ...current, [position]: event.target.value }))}
          />
        </label>
      ))}
      {error ? <p className="error">{error}</p> : null}
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!correct || busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            onConfirmed().catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : 'Could not save. Please try again.');
              setBusy(false);
            });
          }}
        >
          {busy ? 'Saving…' : 'Confirm'}
        </button>
        <button type="button" className="link" onClick={() => setStep('show')}>
          Show the words again
        </button>
      </div>
    </section>
  );
}
