#!/usr/bin/env bun

/**
 * The account switcher renders the SERVER's device directory. This refuses to
 * let the flat, client-reconstructed account list back in.
 *
 * ## What was retired, and why a guard rather than a memory
 *
 * Before ADR 0002 the switcher was a list of ACCOUNTS the client assembled
 * itself: `listAccounts()` (the caller's own account graph) unioned with the
 * device's session set, deduped by `accountId`, hydrated with `getUsersByIds()`.
 * That union was not merely redundant work. A client holds exactly ONE caller's
 * account graph and cannot enumerate another principal's, so on a device holding
 * two people it presented one person's answer as the device's — and switchability,
 * which is an authorization question, was being decided client-side. The
 * replacement is `GET /session/device/directory`: principals, the contexts each
 * may act as, and a switch keyed on the `principal acting as account` PAIR
 * (`activateContext(contextId)`), never on an account id.
 *
 * The removal (#947, #955, #960) deleted `accountProjection.ts`, `accountStore.ts`
 * and `useSwitchableAccounts.ts` outright. What makes that fragile is not the
 * code — it is that the flat list comes back in SMALL pieces, each individually
 * reasonable. A surface needs "all the accounts" and reaches for `listAccounts()`
 * because it is right there on `OxyServices`. A hook wants one array instead of
 * a grouped one and flattens the rows. A snapshot grows an `accounts` field
 * "just for this screen". None of those fails a build; the first one that DOES
 * fail something is the fourth or fifth, by which point the switcher has two
 * sources again and nobody decided that.
 *
 * So this is a decision gate, not a lint. Bringing any of it back is allowed —
 * it just has to be a decision somebody makes on purpose, by deleting the
 * relevant entry below and saying why.
 *
 * ## The rules
 *
 *   1. **Retired identifiers**, anywhere in tracked source. The exported names
 *      and module paths that left `@oxyhq/core` and `@oxyhq/services` in the
 *      cutover. Every one of them is verified absent from this tree; a match is
 *      always a reintroduction.
 *   2. **Scoped bans** — a call that is perfectly legitimate elsewhere but is
 *      the retired mechanism inside ONE file. `listAccounts()` is how the
 *      Console builds its workspace tree and must keep working; inside
 *      `AccountDialogController` it is the client rebuilding a device it cannot
 *      see all of. The file is required to exist, so a rename cannot quietly
 *      turn the rule off.
 *   3. **Sentinels** — identifiers of the REPLACEMENT that must be present, in
 *      quantity. This is the positive control: rules 1 and 2 are absence checks,
 *      and an absence check that scanned nothing reports exactly what a clean
 *      tree reports. If the file listing breaks, or the comment stripper starts
 *      eating whole files, the sentinel counts collapse to zero and the run
 *      fails loudly instead of passing silently.
 *
 * `KNOWN_EXCEPTIONS` sits across rules 1 and 2, one LINE at a time. It exists
 * for one shape: a check that ASSERTS the absence of a banned name has to spell
 * the name. Deleting such a line to satisfy this scanner would delete the
 * assertion, leaving the repository less protected than before the guard was
 * added — so the line is excused and the list is required to shrink.
 *
 * ## Comments are read as prose, and that is deliberate
 *
 * Only the CODE part of each line is scanned. This repository's comments are
 * full of past-tense prose about what a mechanism replaced — `useDeviceSwitcher`
 * carries a paragraph naming `SwitchableAccount[]`, `listAccounts()` and
 * `getUsersByIds()` explaining exactly why the union was wrong, and that
 * paragraph is the most valuable thing in the file for whoever next wonders
 * whether to rebuild it. A guard that forbade writing it down would be asking
 * the repository to forget its own reasoning, and would be turned off by
 * whoever tripped over it first.
 *
 * Markdown is out of scope entirely for the same reason: none of the scan
 * patterns can match a `.md`/`.mdx` path, because docs are where the history of
 * a migration is supposed to live.
 *
 * Usage:  bun scripts/validate-no-flat-account-list.mjs
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The tree to scan. Overridable so the self-test can point the REAL validator at
 * a scratch checkout instead of asserting against a copy of its own logic.
 */
const repositoryRoot = process.env.FLAT_ACCOUNT_LIST_VALIDATOR_ROOT
  ? resolve(process.env.FLAT_ACCOUNT_LIST_VALIDATOR_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Fixture trees are a handful of files, so the real floors would fail every
 * self-test case for the wrong reason. This lowers them to 1 — it never removes
 * them, so a fixture run still catches a traversal that finds nothing, and the
 * floors that matter stay hard in every normal run.
 */
const fixtureFloors = process.env.FLAT_ACCOUNT_LIST_VALIDATOR_FIXTURE_FLOORS === "1";

/**
 * Names that left the packages in the ADR 0002 cutover. Each is verified absent
 * from tracked source at the commit that added this guard, so a match is never
 * ambiguous.
 *
 * Matched with word boundaries, which keeps overlapping names apart:
 * `SwitchableAccount` does not fire on `SwitchableAccountUser` or on
 * `useSwitchableAccounts`, so each entry reports itself and the message names
 * the thing that actually came back.
 */
const RETIRED_IDENTIFIERS = [
  {
    name: "SwitchableAccount",
    was: "@oxyhq/core's flat switcher row — one ACCOUNT, with no answer to whose route it is",
    instead: "SwitcherPrincipalRow / DeviceContext, grouped by the person who can operate them",
  },
  {
    name: "SwitchableAccountUser",
    was: "the profile half of that row, hydrated client-side from getUsersByIds()",
    instead: "the directory's own principal/context display fields, resolved by the server",
  },
  {
    name: "ProjectSwitchableAccountsInput",
    was: "the projection's input: the device session set plus the caller's account graph",
    instead: "DeviceDirectory — one server-authoritative read model, no client union",
  },
  {
    name: "projectSwitchableAccounts",
    was: "the client-side union of device sign-ins and the caller's graph, deduped by accountId",
    instead: "projectDevicePrincipals + buildSwitcherRows over the server's directory",
  },
  {
    name: "switchableAccountIds",
    was: "the id set that union produced, used to decide which profiles to fetch",
    instead: "nothing — the directory arrives hydrated, so there is no second fetch to plan",
  },
  {
    name: "useSwitchableAccounts",
    was: "@oxyhq/services' hook over that projection",
    instead: "useDeviceSwitcher",
  },
  {
    name: "UseSwitchableAccountsResult",
    was: "that hook's return type",
    instead: "UseDeviceSwitcherResult",
  },
  {
    name: "useAccountStore",
    was: "the provider's second copy of the session facts, beside SessionClient's",
    instead: "the OxyRuntime snapshot — one owner for the facts and the order they appear in",
  },
  {
    name: "switchTo",
    was: "the account-id-keyed switch on the dialog controller",
    instead: "activateContext(contextId) — the `principal acting as account` pair",
  },
  {
    name: "session/accountProjection",
    was: "the deleted module holding the projection",
    instead: "session/deviceDirectory + session/deviceSwitcherRows",
  },
  {
    name: "stores/accountStore",
    was: "the deleted module holding the provider's account copy",
    instead: "ui/runtime — createOxyRuntime and its snapshot",
  },
];

/**
 * Calls that are legitimate in the repository at large but ARE the retired
 * mechanism inside one file.
 *
 * `listAccounts()` is how the Console builds its workspace tree and how the
 * accounts app lists organizations; banning it everywhere would be wrong. Inside
 * `AccountDialogController` it was one of the three requests the directory
 * replaced with one, and the one that made the switcher answer with the caller's
 * graph instead of the device's contents.
 *
 * `file` must exist and be readable. A scoped rule whose file has moved is a
 * rule that has silently stopped running, which is worse than not having it.
 */
const SCOPED_BANS = [
  {
    file: "packages/core/src/session/accountDialogController.ts",
    name: "listAccounts",
    reason:
      "the dialog reads GET /session/device/directory and nothing else. Fetching the caller's "
      + "account graph here is what made a two-person device render one person's answer.",
  },
  {
    file: "packages/core/src/session/accountDialogController.ts",
    name: "getUsersByIds",
    reason:
      "the directory arrives with names, handles and avatars already resolved. A profile "
      + "hydration pass here means something is being assembled client-side again.",
  },
];

/**
 * Deliberate, reasoned survivals. Each entry excuses findings in ONE file whose
 * matched line contains `pattern`.
 *
 * Listed one LINE at a time, never one pattern per file: a file-level excuse
 * would let a real reintroduction sit in the same file as the assertion that
 * there is none.
 *
 * The list must only SHRINK. An entry that stops matching anything FAILS the
 * run, so a workaround cannot outlive the thing it worked around — a stale
 * exception is indistinguishable from a live one until somebody audits the list,
 * and nobody audits the list.
 */
const KNOWN_EXCEPTIONS = [
  // A check that ASSERTS the absence of `switchTo` cannot avoid naming it. It is
  // the same kind of thing as this guard, one layer down, and it covers what a
  // text scan cannot: `switchTo` is unique enough to ban repository-wide, but the
  // snapshot's `accounts` field is not, so that half has to be a runtime
  // assertion against a real controller. Deleting the line to satisfy this
  // scanner would delete the assertion and leave the repository less protected
  // than before the guard existed.
  {
    file: "packages/core/src/session/__tests__/accountDialogShape.test.ts",
    pattern: "expect('switchTo' in controller)",
    reason:
      "The runtime assertion that the account-id-keyed switch is gone from the controller. "
      + "A test cannot assert the absence of a member without naming the member.",
  },
];

/**
 * The positive control. Each of these is part of the mechanism that REPLACED the
 * flat list, so a healthy tree carries them in quantity; a broken scan carries
 * none of them and is indistinguishable from a clean tree without this check.
 *
 * Floors are set well under the counts measured when this guard was written
 * (98 / 42 / 12 / 100 / 25 raw occurrences), so ordinary refactoring does not
 * trip them — they are here to catch a scan that found NOTHING, not to freeze a
 * number. Counted on CODE lines only, through the same stripper the bans use, so
 * a stripper that starts eating whole lines fails here first.
 */
const REQUIRED_SENTINELS = [
  { name: "activateContext", minimum: fixtureFloors ? 1 : 20, proves: "the contextId-keyed switch is wired" },
  { name: "useDeviceSwitcher", minimum: fixtureFloors ? 1 : 8, proves: "the replacement hook is in use" },
  { name: "buildSwitcherRows", minimum: fixtureFloors ? 1 : 3, proves: "rows are built from the directory" },
  { name: "DeviceDirectory", minimum: fixtureFloors ? 1 : 20, proves: "the server read model is the source" },
];

const MINIMUM_SOURCE_FILES = fixtureFloors ? 1 : 1500;

const SOURCE_FILE = /\.(?:tsx?|jsx?|mjs|cjs)$/;

/**
 * The guard cannot be its own subject. This file names every retired identifier
 * because that is what it is FOR, and the self-test carries a fixture for each;
 * scanned, the pair reports itself on every run.
 *
 * Excluded by path rather than by content, so ordinary edits to the guard's own
 * wording never fight it. A rename cannot make this fail quietly: the renamed
 * file falls back into the scan and reports itself loudly, which is the signal
 * to update this list.
 */
const GUARD_OWN_FILES = new Set([
  "scripts/validate-no-flat-account-list.mjs",
  "scripts/test-validate-no-flat-account-list.mjs",
]);

/**
 * The CODE part of each line — comments removed, everything else kept verbatim
 * so column positions and quoting survive.
 *
 * Block comments are tracked across lines with a running flag rather than by
 * each line's leading `*`, so a docblock is recognised as a whole. A `//` is
 * only treated as a comment when it is NOT preceded by `:`, which keeps a
 * `https://` inside a real string from blanking the rest of a code line — the
 * one over-strip that would make this gate blind rather than noisy.
 *
 * Returns one entry per input line so reported line numbers stay true.
 */
function codeLinesOf(text) {
  const out = [];
  let inBlock = false;

  for (const raw of text.split("\n")) {
    let rest = raw;
    let code = "";

    while (rest.length > 0) {
      if (inBlock) {
        const close = rest.indexOf("*/");
        if (close === -1) {
          rest = "";
          break;
        }
        rest = rest.slice(close + 2);
        inBlock = false;
        continue;
      }
      const open = rest.indexOf("/*");
      if (open === -1) {
        code += rest;
        rest = "";
        break;
      }
      code += rest.slice(0, open);
      rest = rest.slice(open + 2);
      inBlock = true;
    }

    out.push(code.replace(/(?<!:)\/\/.*$/, ""));
  }

  return out;
}

/** Every file git tracks, repo-relative — so ignored and generated files cannot count. */
function trackedFiles() {
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed in ${repositoryRoot}: ${listed.stderr ?? listed.error}`);
  }
  return listed.stdout.split("\0").filter(Boolean);
}

/**
 * Read a tracked file, or record WHY it could not be read and skip it.
 *
 * `git ls-files` reports the INDEX, which can name a file the working tree does
 * not have — a half-applied checkout, an interrupted rebase, a stale worktree.
 * Left unhandled that throws an ENOENT out of the middle of the scan: the run
 * ends with no verdict, and the reason reads like a bug in the guard rather than
 * a fact about the tree. Recording it as a FAILURE keeps the run loud and
 * finishes the other files.
 */
async function readTrackedFile(path) {
  try {
    return await readFile(resolve(repositoryRoot, path), "utf8");
  } catch (error) {
    failures.push(
      `${path} is tracked by git but could not be read (${error.code ?? error.message}) — `
      + "the working tree disagrees with the index, so this scan was incomplete",
    );
    return null;
  }
}

const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A whole-word match. `\b` around a name that starts or ends with `/` would
 * never fire, so the module-path entries anchor on the path separator instead —
 * `session/accountProjection` has to match inside a quoted specifier.
 */
function wordPattern(name) {
  const escaped = escapeForRegExp(name);
  return name.includes("/") ? new RegExp(escaped) : new RegExp(`\\b${escaped}\\b`);
}

const findings = [];
const failures = [];

const tracked = trackedFiles();
const sources = tracked.filter((path) => SOURCE_FILE.test(path) && !GUARD_OWN_FILES.has(path));

const retiredPatterns = RETIRED_IDENTIFIERS.map((entry) => ({ ...entry, pattern: wordPattern(entry.name) }));
const sentinelPatterns = REQUIRED_SENTINELS.map((entry) => ({ ...entry, pattern: wordPattern(entry.name), seen: 0 }));
const scopedByFile = new Map();
for (const ban of SCOPED_BANS) {
  const existing = scopedByFile.get(ban.file) ?? [];
  existing.push({ ...ban, pattern: wordPattern(ban.name), seenFile: false });
  scopedByFile.set(ban.file, existing);
}

// -------------------------------------------------- 1 & 3. bans and sentinels ---

for (const path of sources) {
  const text = await readTrackedFile(path);
  if (text === null) continue;
  const code = codeLinesOf(text);
  const scoped = scopedByFile.get(path);
  if (scoped) for (const ban of scoped) ban.seenFile = true;

  for (const [index, line] of code.entries()) {
    if (line.trim().length === 0) continue;

    for (const entry of retiredPatterns) {
      if (!entry.pattern.test(line)) continue;
      findings.push({
        file: path,
        line: index + 1,
        text: line.trim().slice(0, 160),
        rule: `${entry.name} is back — it was ${entry.was}. Use ${entry.instead}.`,
      });
    }

    if (scoped) {
      for (const ban of scoped) {
        if (!ban.pattern.test(line)) continue;
        findings.push({
          file: path,
          line: index + 1,
          text: line.trim().slice(0, 160),
          rule: `${ban.name} is called here again — ${ban.reason}`,
        });
      }
    }

    for (const sentinel of sentinelPatterns) {
      if (sentinel.pattern.test(line)) sentinel.seen += 1;
    }
  }
}

// ---------------------------------------------------------- 2. exceptions ---

const honoured = new Set();
const unexcused = findings.filter((finding) => {
  const entry = KNOWN_EXCEPTIONS.find(
    (exception) => exception.file === finding.file && finding.text.includes(exception.pattern),
  );
  if (!entry) return true;
  honoured.add(entry);
  return false;
});

for (const entry of KNOWN_EXCEPTIONS) {
  if (honoured.has(entry)) continue;
  failures.push(
    `KNOWN_EXCEPTIONS still excuses "${entry.pattern}" in ${entry.file}, which no longer matches anything. `
    + "The reference is gone or the file moved — delete the entry so the list keeps describing the tree.",
  );
}

// ------------------------------------------------------- 3. scoped-ban files ---

for (const [file, bans] of scopedByFile) {
  if (bans[0].seenFile) continue;
  failures.push(
    `SCOPED_BANS names ${file}, which is not a tracked source file here. `
    + `The rules on it (${bans.map((ban) => ban.name).join(", ")}) have stopped running — `
    + "point them at the file's new home, or delete them if the mechanism they guard is gone.",
  );
}

// ----------------------------------------------------------- 5. vacuity floors ---

if (sources.length < MINIMUM_SOURCE_FILES) {
  failures.push(
    `${sources.length} source files scanned is below the ${MINIMUM_SOURCE_FILES} floor — `
    + "the file listing is probably broken, and a broken listing reports a clean tree",
  );
}

for (const sentinel of sentinelPatterns) {
  if (sentinel.seen >= sentinel.minimum) continue;
  failures.push(
    `${sentinel.name} was found on ${sentinel.seen} code lines, below the ${sentinel.minimum} floor `
    + `(it proves ${sentinel.proves}). Either the replacement mechanism is being dismantled, or this `
    + "scan is not reading the code it thinks it is — and an absence check that read nothing reports "
    + "exactly what a clean tree reports.",
  );
}

// ---------------------------------------------------------------------- verdict ---

if (unexcused.length > 0 || failures.length > 0) {
  console.error("Flat account-list guard failed:\n");
  for (const finding of unexcused) {
    console.error(`  ${finding.file}:${finding.line}: ${finding.rule}`);
    console.error(`    ${finding.text}\n`);
  }
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    "  The account switcher renders GET /session/device/directory: principals, the contexts\n"
    + "  each may act as, and a switch keyed on the pair. A client holds one caller's account\n"
    + "  graph and cannot enumerate another principal's, so rebuilding the list here answers\n"
    + "  with one person's accounts on a device holding two. See docs/adr/0002 and issue #937.\n",
  );
  process.exit(1);
}

console.log(
  `Flat account-list guard passed — ${sources.length} source files scanned; `
  + `${RETIRED_IDENTIFIERS.length} retired identifiers and ${SCOPED_BANS.length} scoped bans absent; `
  + `${honoured.size} of ${KNOWN_EXCEPTIONS.length} known exceptions honoured; `
  + `sentinels present (${sentinelPatterns.map((s) => `${s.name}×${s.seen}`).join(", ")}).`,
);
