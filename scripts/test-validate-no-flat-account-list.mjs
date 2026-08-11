#!/usr/bin/env bun

/**
 * Mutation-tests `validate-no-flat-account-list.mjs`.
 *
 * A guard that has only ever been seen to pass is indistinguishable from one
 * that cannot fail, and every part of this one fails QUIET: a broken
 * `git ls-files` reports a clean tree, a comment stripper that eats whole lines
 * reports a clean tree, a regex with a typo reports a clean tree. Each case
 * below breaks exactly one thing and requires the guard to fail with the words
 * that identify the right rule.
 *
 * The cases that must PASS matter as much. This repository deliberately keeps
 * past-tense prose naming the retired mechanism — `useDeviceSwitcher`'s docblock
 * spells out `SwitchableAccount[]`, `listAccounts()` and `getUsersByIds()` in
 * order to explain why that union was wrong — and a guard that fired on it would
 * be disabled by whoever hit it first.
 *
 * Fixtures are real trees with a real `git init`, so the guard's actual file
 * listing runs rather than a stand-in for it.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-no-flat-account-list.mjs");

/**
 * Run the REAL validator against a scratch checkout.
 *
 * `realFloors` runs it with production floors, which is the only way to see the
 * source-file floor fire; every other case relaxes them, since a fixture tree of
 * eight files would otherwise fail for a reason that has nothing to do with the
 * account list. The sentinel floors survive relaxation at 1, so their case still
 * runs under fixture floors.
 */
async function runAgainst(files, { realFloors = false, removeAfterAdd = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "flat-account-list-validator-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }

    // `-f` because a developer's global excludes file can legitimately ignore
    // paths a fixture depends on, which would drop them from the listing and
    // make a case pass for the wrong reason.
    Bun.spawnSync({ cmd: ["git", "-c", "init.defaultBranch=main", "init", "-q"], cwd: root });
    Bun.spawnSync({ cmd: ["git", "add", "-A", "-f"], cwd: root });

    // Deleted AFTER `git add`, so the path stays in the index while the working
    // tree loses it. That divergence is real — a half-applied checkout or an
    // interrupted rebase produces it — and it is the only way to reach the
    // unreadable-file branch, which cannot be staged into existence.
    for (const path of removeAfterAdd) await rm(join(root, path), { force: true });

    const environment = { ...process.env, FLAT_ACCOUNT_LIST_VALIDATOR_ROOT: root };
    if (!realFloors) environment.FLAT_ACCOUNT_LIST_VALIDATOR_FIXTURE_FLOORS = "1";

    const proc = Bun.spawnSync({
      cmd: ["bun", validator],
      cwd: repositoryRoot,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode,
      output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * A clean tree on the directory mechanism.
 *
 * It carries every sentinel on a CODE line, the file `SCOPED_BANS` names, and one
 * file per live `KNOWN_EXCEPTIONS` entry holding the text that entry excuses — so
 * all three rules have something live to be satisfied by in every case below. A
 * fixture that omitted any of them would make the whole file green for the wrong
 * reason: the sentinel floors would fire on every case, the scoped bans would
 * report themselves stale, and so would the exceptions.
 *
 * THE EXCEPTION COUPLING IS DELIBERATE. The self-test then proves the real
 * entries match real text, rather than proving a synthetic list matches
 * synthetic text. Adding an entry to the guard means adding its file here;
 * forgetting turns every case below red with a message naming the entry.
 */
function filler(extra = {}) {
  return {
    "packages/core/src/session/deviceDirectory.ts":
      "import type { DeviceDirectory } from '@oxyhq/contracts';\n"
      + "export function resolveActiveContext(directory: DeviceDirectory | null) {\n"
      + "  return directory?.principals[0]?.contexts[0] ?? null;\n"
      + "}\n",
    "packages/core/src/session/deviceSwitcherRows.ts":
      "import type { DeviceDirectory } from '@oxyhq/contracts';\n"
      + "export function buildSwitcherRows(directory: DeviceDirectory) {\n"
      + "  return directory.principals;\n"
      + "}\n",
    "packages/core/src/session/accountDialogController.ts":
      "/**\n"
      + " * This is ONE request. It used to be three — the directory, plus\n"
      + " * `listAccounts()` and `getUsersByIds()` to rebuild the same tree client-side.\n"
      + " */\n"
      + "export class AccountDialogController {\n"
      + "  async activateContext(contextId: string) {\n"
      + "    return this.sessionClient.activateContext(contextId);\n"
      + "  }\n"
      + "}\n",
    "packages/services/src/ui/hooks/useDeviceSwitcher.ts":
      "import { buildSwitcherRows } from '@oxyhq/core';\n"
      + "export function useDeviceSwitcher() {\n"
      + "  const rows = buildSwitcherRows(directory);\n"
      + "  return { rows, activateContext };\n"
      + "}\n",
    "packages/services/src/index.ts":
      "export { useDeviceSwitcher } from './ui/hooks/useDeviceSwitcher';\n"
      + "export type { DeviceDirectory } from './ui/types';\n"
      + "export { activateContext } from './ui/runtime';\n",
    "packages/auth/components/account-chooser.tsx":
      "export function AccountChooser({ activateContext }: { activateContext: (id: string) => void }) {\n"
      + "  return null;\n"
      + "}\n",
    "packages/console/src/hooks/use-account.tsx":
      "export const useAccounts = () => useQuery({ queryFn: () => oxyServices.listAccounts() });\n",
    "packages/core/src/session/__tests__/accountDialogShape.test.ts":
      "it('offers no account-id switch', () => {\n"
      + "  expect('switchTo' in controller).toBe(false);\n"
      + "  expect(typeof controller.activateContext).toBe('function');\n"
      + "});\n",
    ...extra,
  };
}

/** One realistic reintroduction shape per retired identifier. */
const reintroductions = [
  {
    name: "SwitchableAccount",
    path: "packages/services/src/ui/hooks/useRows.ts",
    body: "import type { SwitchableAccount } from '@oxyhq/core';\nexport const rows: SwitchableAccount[] = [];\n",
  },
  {
    name: "SwitchableAccountUser",
    path: "packages/services/src/ui/hooks/useRows.ts",
    body: "import type { SwitchableAccountUser } from '@oxyhq/core';\nexport let user: SwitchableAccountUser;\n",
  },
  {
    name: "ProjectSwitchableAccountsInput",
    path: "packages/core/src/session/rebuild.ts",
    body: "const input: ProjectSwitchableAccountsInput = { graph, state };\nexport default input;\n",
  },
  {
    name: "projectSwitchableAccounts",
    path: "packages/core/src/session/rebuild.ts",
    body: "export const accounts = projectSwitchableAccounts({ graph, state, profilesById });\n",
  },
  {
    name: "switchableAccountIds",
    path: "packages/core/src/session/rebuild.ts",
    body: "const ids = switchableAccountIds(this.sessionClient.getState(), this.graph);\nexport default ids;\n",
  },
  {
    name: "useSwitchableAccounts",
    path: "packages/auth/components/login-form.tsx",
    body: "import { useSwitchableAccounts } from '@oxyhq/services';\nexport const rows = useSwitchableAccounts();\n",
  },
  {
    name: "UseSwitchableAccountsResult",
    path: "packages/services/src/ui/hooks/useRows.ts",
    body: "export function useRows(): UseSwitchableAccountsResult {\n  return { accounts: [] };\n}\n",
  },
  {
    name: "useAccountStore",
    path: "packages/services/src/ui/context/OxyContext.tsx",
    body: "const accounts = useAccountStore((state) => state.accounts);\nexport default accounts;\n",
  },
  {
    name: "switchTo",
    path: "packages/services/src/ui/components/OxyAuthChooser.tsx",
    body: "export const onPress = (accountId: string) => controller.switchTo(accountId);\n",
  },
  {
    name: "session/accountProjection",
    path: "packages/core/src/index.ts",
    body: "export { projectAccounts } from './session/accountProjection';\n",
  },
  {
    name: "stores/accountStore",
    path: "packages/services/src/ui/index.ts",
    body: "export * from './stores/accountStore';\n",
  },
];

const cases = [
  {
    name: "a tree on the device directory passes",
    files: filler(),
    expectFailure: false,
  },

  // ------------------------------------------------- 1. retired identifiers ---
  ...reintroductions.map((entry) => ({
    name: `${entry.name} coming back is rejected`,
    files: filler({ [entry.path]: entry.body }),
    expectFailure: true,
    expectOutput: `${entry.name} is back`,
  })),

  {
    // THE WORD-BOUNDARY PROOF. `useSwitchableAccounts` contains the character
    // sequence `SwitchableAccount`, and a substring matcher would report the
    // hook as two separate reintroductions. That is not a cosmetic difference:
    // the message names the thing to remove, and a reader told to delete a type
    // that is not in the file stops trusting the guard.
    name: "the hook does NOT also report itself as the row type",
    files: filler({
      "packages/auth/components/login-form.tsx": "import { useSwitchableAccounts } from '@oxyhq/services';\n",
    }),
    expectFailure: true,
    expectOutput: "useSwitchableAccounts is back",
    expectNotOutput: "SwitchableAccount is back",
  },
  {
    // The other half of the boundary. `switchToAccount` is a LIVE method on
    // `useOxy()` — it is what `sessionMode: 'identity'` throws from — so a guard
    // that fired on it would break every consumer's typecheck for no reason.
    name: "the live switchToAccount is not mistaken for the retired switchTo",
    files: filler({
      "packages/services/src/ui/session/identityBinding.ts":
        "export const switchToAccount = () => {\n  throw new IdentityBoundSessionError();\n};\n",
    }),
    expectFailure: false,
  },

  // --------------------------------------------- 2. prose stays legal ---------
  {
    // THE CASE THIS GUARD LIVES OR DIES BY. This is the real docblock from
    // `useDeviceSwitcher.ts`, near-verbatim: it names the retired type, both
    // retired calls and the union they formed, because that paragraph is the
    // reason the next person does not rebuild it. Firing on it would get the
    // guard deleted rather than the comment.
    name: "the past-tense docblock explaining what was removed does NOT fire",
    files: filler({
      "packages/services/src/ui/hooks/useDeviceSwitcher.ts":
        "/**\n"
        + " * It used to hand back a flat `SwitchableAccount[]` assembled here from\n"
        + " * `listAccounts()` + `getUsersByIds()` unioned with the device's session set.\n"
        + " * That union was not merely redundant: the client holds ONE caller's account\n"
        + " * graph, so on a device holding two people it presented one person's answer\n"
        + " * as the device's, and switchability — an authorization question — was decided\n"
        + " * client-side. Selecting a row activates a `contextId`, never an `accountId`,\n"
        + " * so there is no `switchTo` and no `projectSwitchableAccounts` any more.\n"
        + " */\n"
        + "export function useDeviceSwitcher() {\n"
        + "  return { rows: buildSwitcherRows(directory), activateContext };\n"
        + "}\n",
    }),
    expectFailure: false,
  },
  {
    name: "a line comment naming a retired identifier does NOT fire",
    files: filler({
      "packages/core/src/session/rebuild.ts":
        "// projectSwitchableAccounts and switchableAccountIds were deleted in #960.\n"
        + "export const directoryIsTheSource = true;\n",
    }),
    expectFailure: false,
  },
  {
    // The distinguishing shape for stripping a TRAILING comment rather than
    // only a full-line one. Without it, a stripper that handled only lines
    // beginning with `//` would pass every other case in this file.
    name: "a trailing comment on a code line does NOT fire",
    files: filler({
      "packages/core/src/session/rebuild.ts":
        "export const rows = buildSwitcherRows(directory); // replaces projectSwitchableAccounts\n",
    }),
    expectFailure: false,
  },
  {
    // The distinguishing shape for tracking block comments ACROSS lines. The
    // identifier sits on a line with no `*` prefix and no `//`, so a per-line
    // heuristic would report it; only a running in-block flag gets this right.
    name: "an unprefixed line inside a block comment does NOT fire",
    files: filler({
      "packages/core/src/session/rebuild.ts":
        "/*\n"
        + "The projection used to be called\n"
        + "projectSwitchableAccounts\n"
        + "and it is gone.\n"
        + "*/\n"
        + "export const directoryIsTheSource = true;\n",
    }),
    expectFailure: false,
  },
  {
    // ...and the inverse, which is what stops the block-comment handling from
    // being a hole: real code sharing a line with the END of a block comment is
    // still scanned. A stripper that blanked the whole line would pass the case
    // above and silently miss this one.
    name: "code after the end of a block comment IS still scanned",
    files: filler({
      "packages/core/src/session/rebuild.ts":
        "/* the old projection\n"
        + "lived here */ export const rows = projectSwitchableAccounts(input);\n",
    }),
    expectFailure: true,
    expectOutput: "projectSwitchableAccounts is back",
  },
  {
    // Markdown is out of scope by construction — no scan pattern can match a
    // `.md`/`.mdx` path. This case fires if someone widens SOURCE_FILE, which is
    // the change that would actually put docs back in scope.
    name: "markdown describing the retired mechanism does NOT fire",
    files: filler({
      "docs/auth/index.md":
        "The chooser used to call `useSwitchableAccounts`, which projected a flat\n"
        + "`SwitchableAccount[]` from `listAccounts()`. It reads the directory now.\n",
      "packages/auth/docs/index.mdx": "The IdP enumerated accounts via `useSwitchableAccounts` before ADR 0002.\n",
    }),
    expectFailure: false,
  },
  {
    // The guard names every retired identifier by necessity, and this file
    // carries a fixture for each. Scanned, the pair reports itself on every run
    // — which is what happened the moment they became visible to `git ls-files`.
    name: "the guard's own source and self-test are not their own subject",
    files: filler({
      "scripts/validate-no-flat-account-list.mjs":
        "const RETIRED = ['SwitchableAccount', 'projectSwitchableAccounts', 'useAccountStore', 'switchTo'];\n"
        + "export default RETIRED;\n",
      "scripts/test-validate-no-flat-account-list.mjs":
        "const fixture = \"import type { SwitchableAccountUser } from '@oxyhq/core';\";\n"
        + "export default fixture;\n",
    }),
    expectFailure: false,
  },

  // ----------------------------------------------------- 3. scoped bans -------
  {
    name: "listAccounts inside the dialog controller is rejected",
    files: filler({
      "packages/core/src/session/accountDialogController.ts":
        "export class AccountDialogController {\n"
        + "  async refresh() {\n"
        + "    this.graph = await this.oxyServices.listAccounts();\n"
        + "    return this.activateContext;\n"
        + "  }\n"
        + "}\n",
    }),
    expectFailure: true,
    expectOutput: "listAccounts is called here again",
  },
  {
    name: "getUsersByIds inside the dialog controller is rejected",
    files: filler({
      "packages/core/src/session/accountDialogController.ts":
        "export class AccountDialogController {\n"
        + "  async hydrate(ids: string[]) {\n"
        + "    const users = await this.oxyServices.getUsersByIds(ids);\n"
        + "    return { users, activateContext: this.activateContext };\n"
        + "  }\n"
        + "}\n",
    }),
    expectFailure: true,
    expectOutput: "getUsersByIds is called here again",
  },
  {
    // THE NARROWNESS PROOF. `listAccounts()` is how the Console builds its
    // workspace tree and it must keep working; the filler calls it there in
    // EVERY case in this file. A guard that banned it repository-wide would have
    // been reverted the first time somebody touched the Console.
    name: "listAccounts outside the dialog controller passes",
    files: filler({
      "packages/console/src/hooks/use-account.tsx":
        "export const useAccounts = () => useQuery({\n"
        + "  queryFn: () => oxyServices.listAccounts(),\n"
        + "});\n",
    }),
    expectFailure: false,
  },
  {
    // A scoped rule whose file has moved is a rule that has silently stopped
    // running — the worst state for a check to be in, because the run still
    // reports success. Renaming the controller must fail loudly and name the
    // rules that went dark.
    name: "a scoped ban whose file is gone FAILS the run",
    files: (() => {
      const files = filler();
      delete files["packages/core/src/session/accountDialogController.ts"];
      return files;
    })(),
    expectFailure: true,
    expectOutput: "have stopped running",
  },

  // ------------------------------------------------------- 4. exceptions -------
  {
    // THE NARROWNESS PROOF, and the reason entries are per-LINE rather than
    // per-file. The shape test is excused for the one line that ASSERTS
    // `switchTo` is gone. A real `switchTo` call added to that SAME file must
    // still fail, or the exception is a hole rather than an allowlist.
    name: "an excused file still fails on a line the exception does not cover",
    files: filler({
      "packages/core/src/session/__tests__/accountDialogShape.test.ts":
        "it('offers no account-id switch', () => {\n"
        + "  expect('switchTo' in controller).toBe(false);\n"
        + "});\n"
        + "const revived = await controller.switchTo(accountId);\n",
    }),
    expectFailure: true,
    expectOutput: "switchTo is back",
  },
  {
    // The shrink discipline. A tree where the excused line no longer exists must
    // FAIL, so an exception cannot outlive the thing it worked around — a stale
    // entry is indistinguishable from a live one until somebody audits the list,
    // and nobody audits the list.
    name: "a KNOWN_EXCEPTIONS entry that matches nothing FAILS the run",
    files: (() => {
      const files = filler();
      delete files["packages/core/src/session/__tests__/accountDialogShape.test.ts"];
      return files;
    })(),
    expectFailure: true,
    expectOutput: "no longer matches anything",
  },

  // ------------------------------------------------- 5. the positive control ---
  {
    // The reason this guard has sentinels at all. Absence checks answer
    // identically on a clean tree and on a scan that read nothing, so something
    // has to prove the scan is reading real code. Here the replacement mechanism
    // is simply not present.
    name: "a tree with none of the replacement mechanism FAILS as vacuous",
    files: {
      "package.json": `${JSON.stringify({ name: "fixture" }, null, 2)}\n`,
      "packages/core/src/session/accountDialogController.ts": "export class AccountDialogController {}\n",
      "packages/core/src/session/other.ts": "export const unrelated = true;\n",
    },
    expectFailure: true,
    expectOutput: "below the 1 floor",
  },
  {
    // THE STRIPPER'S OWN VACUITY CASE, and the reason sentinels are counted on
    // CODE lines. Every sentinel is present in this tree, but only inside
    // comments — exactly what a stripper that started blanking whole lines would
    // make the ENTIRE repository look like. Counting raw text would report this
    // healthy.
    name: "sentinels that exist only in comments do NOT satisfy the floor",
    files: {
      "package.json": `${JSON.stringify({ name: "fixture" }, null, 2)}\n`,
      "packages/core/src/session/accountDialogController.ts":
        "// activateContext, useDeviceSwitcher, buildSwitcherRows and DeviceDirectory\n"
        + "// are all named here, and none of them is code.\n"
        + "export class AccountDialogController {}\n",
    },
    expectFailure: true,
    expectOutput: "below the 1 floor",
  },
  {
    name: "a broken file listing cannot pass silently (source-file floor)",
    files: filler(),
    realFloors: true,
    expectFailure: true,
    expectOutput: "below the 1500 floor",
  },
  {
    // A tracked path the working tree does not have. Unhandled, this throws an
    // ENOENT out of the middle of the scan: no verdict, and a failure that reads
    // like a bug in the guard rather than a fact about the tree. It must FAIL
    // rather than skip quietly, because the scan really was incomplete — the
    // unread file is exactly where a reintroduction could sit.
    name: "a tracked file missing from the working tree fails loudly, not with a stack trace",
    files: filler({ "packages/core/src/session/rebuild.ts": "export const directoryIsTheSource = true;\n" }),
    removeAfterAdd: ["packages/core/src/session/rebuild.ts"],
    expectFailure: true,
    expectOutput: "tracked by git but could not be read",
  },
];

let failed = 0;
for (const testCase of cases) {
  const { exitCode, output } = await runAgainst(testCase.files, {
    realFloors: testCase.realFloors === true,
    removeAfterAdd: testCase.removeAfterAdd ?? [],
  });
  const didFail = exitCode !== 0;

  if (didFail !== testCase.expectFailure) {
    console.error(
      `FAIL ${testCase.name}: expected ${testCase.expectFailure ? "a failure" : "a pass"}, `
      + `got exit ${exitCode}\n${output}`,
    );
    failed += 1;
    continue;
  }
  if (testCase.expectOutput && !output.includes(testCase.expectOutput)) {
    console.error(
      `FAIL ${testCase.name}: failed as expected, but the message never said `
      + `"${testCase.expectOutput}"\n${output}`,
    );
    failed += 1;
    continue;
  }
  if (testCase.expectNotOutput && output.includes(testCase.expectNotOutput)) {
    console.error(
      `FAIL ${testCase.name}: the message also said "${testCase.expectNotOutput}", `
      + `which names something that is not in the tree\n${output}`,
    );
    failed += 1;
    continue;
  }
  console.log(`ok   ${testCase.name}`);
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} guard cases failed.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} guard cases passed.`);
