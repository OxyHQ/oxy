# Agent-first workflow

The main thread is a tech lead: it splits the work, launches agents in parallel, coordinates, and spawns a fixer on errors. It does not implement.

Agent roles come from the agent definitions a session has (a repository's `.claude/agents/` or the user's own); this document does not enumerate them. Whatever the roles, three jobs always exist: implementation per area, a test-and-build check before anything is pushed, and a docs pass that puts a new rule in the right layer (a project rule in that project's `AGENTS.md`, a cross-repository rule in `docs/engineering/` of the repository that owns the mechanism, Oxy being the default owner).

## Rules

- **Push only after the tests and build pass.** A request to push or ship runs the test-and-build check first.
- **One worktree per agent**, at `<repo>/.worktrees/<name>`: never the shared checkout, and never a tmpfs scratch directory. A monorepo install is gigabytes, and bun hardlinks from its cache only within one filesystem, so a worktree on tmpfs copies instead and exhausts RAM (`ENOSPC`, killed processes). `stat -c %h node_modules/react/package.json` reads 1 when an install copied and more than 1 when it linked.
- **Before replacing an agent, ask it whether it is alive.** Silence is not death. File modification times cannot judge liveness; to decide whether a directory is in use, use `lsof +D` and `/proc/<pid>/cwd` (bun hardlinks from one cache, so `lsof` names processes from other repositories).
- **"Safe to delete this worktree?" is answered by the forge** (`gh pr view <n> --json state` is `MERGED`). Locally only an empty `git diff --stat origin/main <branch>` proves it; squash merges defeat every other local test.
- **Never `git stash` with several agents on one clone.** The stash stack is repository-global and agents pop each other's entries, so a no-op stash followed by a pop applies another session's work. Copy files aside instead.
- **Namespace scratch writes** under `<scratchpad>/<agent-name>/`. The scratchpad is shared across agents and sessions, and a file one agent writes and reads back can be overwritten by another in between, including a task definition that was then registered and run. Verify a restore against markers from your own edit, and read back the input of a write, not only its output.
- **Hand a foundation branch out to be rebased onto, never merged.** A squashed foundation add/add-conflicts every sibling that merged it, even byte-identical. Say which side is authoritative.
- **Never delegate writes to a fork of yourself that shares your checkout.** A fork inherits your working directory; give any writing agent its own worktree.
- **Verify the branch before editing a shared repository.** Other agents switch branches under you; check `git branch --show-current` immediately before a write, or work in a worktree.

## Fix upstream, never patch

A bug in `@oxy.so/core`, `@oxy.so/services` or Bloom is fixed at its source: an upstream change, build and test, a release by merging the version bump, then bumping the consumer. Never monkey-patch or locally override in the consuming app.
