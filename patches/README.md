# Local Bloom changes

`@oxy.so%2Fbloom@10.4.0.patch` carries the local Bloom dialog/header and grouped
section changes until a Bloom release contains them. It includes source, compiled
modules, declarations, and the `grouped-section` / `usage-card` package exports. The canonical
source worktree is `~/Oxy/Bloom/.worktrees/dialog-page-header`.

After rebuilding Bloom, prepare edits with `bun patch` before copying artifacts;
Bun's ordinary installed files may be hardlinked to its shared cache. Regenerate
the patch and verify a frozen installation plus the Expo playground.

Bun 1.4.3 creates a new patched directory with the first new file's mode. A 0644
first file therefore produced `mkdirat(.../grouped-section, 0644)` followed by
`EACCES` when opening its first child (verified with strace). The first new file
in each new component source/build directory uses patch mode 100755 so Bun
creates a traversable directory. Preserve those mode entries when
regenerating this patch. A frozen install succeeds with them; Bloom source-file
modes remain unchanged.
