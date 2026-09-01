/**
 * A route may AUTHORIZE only against the operator.
 *
 * ## What this is guarding, and what it deliberately is not
 *
 * An operated session carries two identities: the SUBJECT it authenticates as
 * (the managed account) and the OPERATOR whose RBAC applies (the human recorded
 * on the session). `#934` decided that authority follows the operator; the
 * conversion was left half-done, and four route files went on authorizing
 * against the subject — which refused an organization's own owner the right to
 * create an agent under it, because an organization is not a member of itself.
 *
 * The failure is not "a route used the subject". Routes use the subject all the
 * time, correctly — `POST /accounts` uses it three lines above the authorization
 * call to decide where a new child hangs, and that is right: acting as an
 * organization means new children belong to the organization. A gate that
 * flagged every use of the subject would fire constantly on correct code, and
 * the first person to hit that noise would silence it.
 *
 * So this gate asks a narrower question, the only one that is always wrong:
 * **what is passed as the PRINCIPAL to an access resolver?**
 * `resolveEffectiveAccess` and `effectiveAccessForAccount` answer "what may this
 * principal do here", and their first argument must always be the operator.
 *
 * ## Why a naming rule rather than dataflow
 *
 * The check reads the first argument and requires it to NAME the operator. That
 * is enforceable without parsing, and it buys the thing that actually prevents
 * the bug: a call site that says which identity it is passing. `resolveEffectiveAccess(userId, …)`
 * looks correct in review — `userId` is "the user", and the reviewer supplies
 * their own idea of which user. `resolveEffectiveAccess(operatorId, …)` cannot be
 * read two ways.
 *
 * A variable holding the operator but named something else fails this. That is
 * intended: the name is the documentation, and this bug was a naming failure
 * before it was a logic one.
 *
 * ## Why the behavioural pair matters more than this file
 *
 * A static gate can be worked around; `accountsCreateAsOperatedAccount.test.ts`
 * cannot. That suite asserts the property itself — an organization's owner may
 * create under it, an editor may not — and it is what turns red if somebody
 * "simplifies" the model rather than the spelling. This file catches the next
 * route BEFORE it ships; that one catches the model changing underneath.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** `packages/api/src/routes/__tests__` → the routes directory. */
const ROUTES = join(__dirname, '..');
/** `…/packages/api` → repo-relative paths in the failure message. */
const PACKAGE_ROOT = join(__dirname, '..', '..', '..');

/**
 * The functions that answer "what may this principal do here". Their first
 * argument IS the authorization principal; everything else a route does with an
 * account id is out of scope.
 */
const ACCESS_RESOLVERS = ['resolveEffectiveAccess', 'effectiveAccessForAccount'];

/**
 * Spellings that name the operator. Anything else — `userId`, `req.user._id`, a
 * subject helper — is the defect this exists to catch.
 */
const OPERATOR_PRINCIPALS = new Set(['operatorId', 'requireOperatorId(req)', 'await resolveOperatorId(req)']);

interface Call {
  readonly file: string;
  readonly line: number;
  readonly principal: string;
}

function routeModules(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === '__tests__') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...routeModules(path));
      continue;
    }
    if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}

/**
 * The first argument of a call, read by balancing brackets from the open paren.
 *
 * Bracket-balanced rather than split on the first comma: a principal is
 * occasionally an expression containing its own commas, and a naive split would
 * report a fragment that matches nothing and fail on correct code.
 */
function firstArgument(source: string, openParen: number): string {
  let depth = 1;
  let argument = '';
  for (let i = openParen; i < source.length; i++) {
    const character = source[i];
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
    if (depth === 1 && character === ',') break;
    argument += character;
  }
  return argument.split(/\s+/).join(' ').trim();
}

/** Every authorization call in every route module, with the principal it passes. */
function authorizationCalls(): Call[] {
  const found: Call[] = [];
  for (const path of routeModules(ROUTES)) {
    const source = readFileSync(path, 'utf8');
    for (const resolver of ACCESS_RESOLVERS) {
      const pattern = new RegExp(`${resolver}\\s*\\(`, 'g');
      let match = pattern.exec(source);
      while (match !== null) {
        found.push({
          file: relative(PACKAGE_ROOT, path).split(sep).join('/'),
          line: source.slice(0, match.index).split('\n').length,
          principal: firstArgument(source, match.index + match[0].length),
        });
        match = pattern.exec(source);
      }
    }
  }
  return found;
}

describe('every route authorizes against the operator', () => {
  const calls = authorizationCalls();

  /**
   * The positive control. Every assertion below passes over an empty list, and an
   * empty list is what a renamed resolver, a moved directory or a broken walk all
   * produce — so the scan is required to have found the calls that exist.
   */
  it('the scan finds the authorization calls it is checking', () => {
    expect(calls.length).toBeGreaterThanOrEqual(6);
    expect(calls.map((call) => call.file)).toEqual(
      expect.arrayContaining([
        'src/routes/accounts.ts',
        'src/routes/applications.ts',
      ])
    );
  });

  it('passes an operator-named principal to every access resolver', () => {
    const authorizingWithSomethingElse = calls
      .filter((call) => !OPERATOR_PRINCIPALS.has(call.principal))
      .map((call) => `${call.file}:${call.line} authorizes with \`${call.principal}\``);

    expect(authorizingWithSomethingElse).toEqual([]);
  });
});
