/**
 * Compile-time proof that the Inbox DTOs serialise to the published wire
 * contract in `@oxy.so/contracts` (`email/messages`).
 *
 * The DTOs in `email.service.ts` carry `Date`s; the wire carries ISO strings.
 * {@link Wire} is exactly what `JSON.stringify` does to them, and each
 * assertion below requires the serialised DTO and the contract's inferred type
 * to be assignable BOTH ways. Change a DTO field without changing the contract
 * — or the contract without the DTO — and this file stops compiling.
 *
 * It exists because the two drifted once, silently: the server sent
 * `attachments[].contentId: null`, the Inbox client's private schema said
 * `string | undefined`, and every mail with an attachment lacking a Content-ID
 * vanished from the inbox. The runtime half of the proof is
 * `__tests__/emailService.contract.test.ts`, which parses real responses.
 */

import type {
  EmailBundleWire,
  EmailContactWire,
  EmailFilterWire,
  EmailMailboxWire,
  EmailMessageWire,
  EmailOutboxWire,
  EmailSystemLabelWire,
  EmailUserLabelWire,
} from '@oxy.so/contracts';
import type { SystemLabel } from '../constants/systemLabels';
import type {
  BundleDto,
  ContactDto,
  FilterDto,
  LabelDto,
  MailboxDto,
  MessageDto,
} from './email.service';
import type { EmailOutboxDto } from './emailOutbox.service';

/** What `JSON.stringify` makes of a value: every `Date` becomes its ISO string. */
export type Wire<T> = T extends Date
  ? string
  : T extends ReadonlyArray<infer U>
    ? Array<Wire<U>>
    : T extends object
      ? { -readonly [K in keyof T]: Wire<T[K]> }
      : T;

/** `true` exactly when `A` and `B` are mutually assignable. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Fails to compile unless its argument is `true`. */
function assertSame<T extends true>(): T | undefined {
  return undefined;
}

assertSame<Same<Wire<MessageDto>, EmailMessageWire>>();
assertSame<Same<Wire<MailboxDto>, EmailMailboxWire>>();
assertSame<Same<Wire<LabelDto>, EmailUserLabelWire>>();
assertSame<Same<Wire<SystemLabel>, EmailSystemLabelWire>>();
assertSame<Same<Wire<FilterDto>, EmailFilterWire>>();
assertSame<Same<Wire<BundleDto>, EmailBundleWire>>();
assertSame<Same<Wire<ContactDto>, EmailContactWire>>();
assertSame<Same<Wire<EmailOutboxDto>, EmailOutboxWire>>();
