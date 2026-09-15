import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { buildMoveQrPayload } from '@oxy.so/core';
import type { IdentityMoveState } from '@oxy.so/contracts';
import { cancelMove, completeMove, readMove, sendMove, startMove, type CarrierPorts, type CarrierSession, type OutgoingMove } from '../identity/carrier';
import { messageOf } from '../identity/ports';

const POLL_MS = 2000;

type Step =
  | { name: 'intro' }
  | { name: 'working'; label: string }
  | { name: 'scan'; move: OutgoingMove; qrSvg: string }
  | { name: 'compare'; move: OutgoingMove; sas: string }
  | { name: 'sent'; move: OutgoingMove }
  | { name: 'moved' }
  | { name: 'ended'; reason: 'expired' | 'cancelled' };

/**
 * Move this account's identity into the Commons app — a MOVE, not a copy.
 *
 * The browser shows a code, Commons scans it, both screens show the same six
 * digits, and only after the person confirms they match is the identity sealed
 * for that phone. The web copy is destroyed only once Commons proves — with a
 * signature this page checks itself — that it holds the identity.
 */
export function MoveFlow({ ports, session, onDone }: { ports: CarrierPorts; session: CarrierSession; onDone: () => void }) {
  const [step, setStep] = useState<Step>({ name: 'intro' });
  const [error, setError] = useState<string | null>(null);
  const moveRef = useRef<OutgoingMove | null>(null);

  // Poll while a move is under way. One request at a time; each step decides
  // what it is waiting for, and completing is handled outside the poll so its
  // failure is always shown.
  useEffect(() => {
    if (step.name !== 'scan' && step.name !== 'sent') return;
    const { move } = step;
    let stopped = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const { state, progress } = await readMove(ports, move);
        if (stopped) return;
        if (progress.kind === 'compare' && step.name === 'scan') {
          setStep({ name: 'compare', move, sas: progress.sas });
          return;
        }
        if (progress.kind === 'received') {
          stopped = true;
          void finish(move, state);
          return;
        }
        if (progress.kind === 'ended') {
          moveRef.current = null;
          setStep({ name: 'ended', reason: progress.reason });
          return;
        }
      } catch (reason) {
        if (stopped) return;
        fail(reason);
        return;
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    timer = window.setTimeout(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [ports, session, step]);

  // Leaving the page mid-move cancels it rather than leaving a live code behind.
  useEffect(
    () => () => {
      const move = moveRef.current;
      if (move) void cancelMove(ports, move).catch(() => undefined);
    },
    [ports],
  );

  function fail(reason: unknown) {
    setError(messageOf(reason));
    setStep({ name: 'intro' });
  }

  async function begin() {
    setError(null);
    setStep({ name: 'working', label: 'Preparing the code…' });
    try {
      const move = await startMove(ports, session);
      moveRef.current = move;
      const qrSvg = await QRCode.toString(buildMoveQrPayload(move.moveId), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      setStep({ name: 'scan', move, qrSvg });
    } catch (reason) {
      fail(reason);
    }
  }

  async function finish(move: OutgoingMove, state: IdentityMoveState) {
    setStep({ name: 'working', label: 'Commons has your identity. Removing it from this browser…' });
    try {
      await completeMove(ports, session, move, state);
      moveRef.current = null;
      setStep({ name: 'moved' });
    } catch (reason) {
      // The web copy is intact: a receipt that does not verify destroys nothing.
      fail(reason);
    }
  }

  async function confirm(move: OutgoingMove, sas: string) {
    setError(null);
    setStep({ name: 'working', label: 'Sending your identity to Commons…' });
    try {
      await sendMove(ports, session, move, sas);
      setStep({ name: 'sent', move });
    } catch (reason) {
      moveRef.current = null;
      await cancelMove(ports, move).catch(() => undefined);
      fail(reason);
    }
  }

  async function stop(move: OutgoingMove) {
    moveRef.current = null;
    await cancelMove(ports, move).catch(() => undefined);
    setStep({ name: 'ended', reason: 'cancelled' });
  }

  const errorLine = error ? <p className="error">{error}</p> : null;

  switch (step.name) {
    case 'intro':
      return (
        <section className="card">
          <h1>Move your identity to Commons</h1>
          <p>Your identity will live in the Commons app on your phone, and this browser will stop keeping it. Your account, username and everything in it stay the same.</p>
          <p>Have Commons open on your phone. If you already use it with another identity, this one can’t be added there.</p>
          {errorLine}
          <div className="actions">
            <button type="button" className="primary" onClick={() => void begin()}>
              Show the code
            </button>
            <button type="button" className="link" onClick={onDone}>
              Back
            </button>
          </div>
        </section>
      );
    case 'working':
      return <p className="status">{step.label}</p>;
    case 'scan':
      return (
        <section className="card">
          <h1>Scan with Commons</h1>
          <p>In Commons, tap <strong>Restore with recovery phrase</strong>, then <strong>Move from the Oxy website</strong>.</p>
          {/* The SVG is generated locally from a fixed-format payload; it carries only the move id. */}
          <div className="qr" role="img" aria-label="Code to scan with Commons" dangerouslySetInnerHTML={{ __html: step.qrSvg }} />
          <p className="note">The code works once and expires in 5 minutes.</p>
          <div className="actions">
            <button type="button" className="link" onClick={() => void stop(step.move)}>
              Cancel
            </button>
          </div>
        </section>
      );
    case 'compare':
      return (
        <section className="card">
          <h1>Do the codes match?</h1>
          <p>Commons is showing a code. Send your identity only if it is exactly this one.</p>
          <p className="sas" aria-label={`Code ${step.sas.split('').join(' ')}`}>
            {step.sas.slice(0, 3)} {step.sas.slice(3)}
          </p>
          {errorLine}
          <div className="actions vertical">
            <button type="button" className="primary" onClick={() => void confirm(step.move, step.sas)}>
              They match — send my identity
            </button>
            <button type="button" className="secondary" onClick={() => void stop(step.move)}>
              They don’t match
            </button>
          </div>
        </section>
      );
    case 'sent':
      return (
        <section className="card">
          <h1>Finishing in Commons…</h1>
          <p>Keep this page open until Commons confirms. Your identity stays here until it does.</p>
        </section>
      );
    case 'moved':
      return (
        <section className="card">
          <h1>Your identity is in Commons</h1>
          <p>This browser no longer keeps it. From now on, approve sign-ins and keep your recovery phrase with the Commons app.</p>
          <div className="actions">
            <button type="button" className="primary" onClick={onDone}>
              Done
            </button>
          </div>
        </section>
      );
    case 'ended':
      return (
        <section className="card">
          <h1>{step.reason === 'expired' ? 'The code expired' : 'Move cancelled'}</h1>
          <p>Nothing was moved. Your identity is still here.</p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => void begin()}>
              Start again
            </button>
            <button type="button" className="link" onClick={onDone}>
              Back
            </button>
          </div>
        </section>
      );
  }
}
