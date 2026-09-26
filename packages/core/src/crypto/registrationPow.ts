/**
 * Registration proof-of-work — the CLIENT half of the anti-automation nonce
 * `auth.registerKey()` (`api/auth.ts`) submits alongside the
 * registration signature. The message format, difficulty and the full design
 * rationale (why 16 bits, why sequential nonces are fine, what this is and
 * isn't a defense against) live in `@oxy.so/protocol`'s
 * `auth/registrationPow.ts` — this file is only the solve loop.
 */

import './polyfill';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
  meetsRegistrationPowDifficulty,
  registrationPowMessage,
  REGISTRATION_POW_DIFFICULTY_BITS,
} from '@oxy.so/protocol';

/**
 * How many attempts the grind loop runs before yielding to the event loop.
 *
 * A synchronous hot loop long enough to matter (an average solve at 16 bits
 * is 65,536 attempts) would otherwise block the JS thread for its entire
 * duration — on a mobile app that means no touch response, no animation, for
 * up to roughly a second. Yielding periodically keeps the UI responsive
 * during the grind at the cost of a handful of event-loop round trips, which
 * is imperceptible next to the grind itself.
 */
const YIELD_EVERY_N_ATTEMPTS = 2000;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Grind a nonce for `publicKey`/`timestamp` that clears
 * {@link REGISTRATION_POW_DIFFICULTY_BITS}, returned as a decimal counter.
 *
 * Hashes with `@noble/hashes/sha256` — pure JS, synchronous, identical output
 * on web/Node/React Native with no native module and no per-attempt bridge
 * crossing (see the difficulty constant's own doc for why that distinction is
 * the whole point). Nonces are sequential (0, 1, 2, …) rather than random: the
 * candidate space a hash function spreads solutions across is dense either
 * way, so a counter finds one exactly as reliably as randomness would, without
 * needing a randomness source at all.
 */
export async function solveRegistrationPow(publicKey: string, timestamp: number): Promise<string> {
  for (let nonce = 0; ; nonce += 1) {
    const candidate = String(nonce);
    const digest = bytesToHex(
      sha256(utf8ToBytes(registrationPowMessage(publicKey, timestamp, candidate)))
    );
    if (meetsRegistrationPowDifficulty(digest, REGISTRATION_POW_DIFFICULTY_BITS)) {
      return candidate;
    }
    if (nonce % YIELD_EVERY_N_ATTEMPTS === YIELD_EVERY_N_ATTEMPTS - 1) {
      await yieldToEventLoop();
    }
  }
}
