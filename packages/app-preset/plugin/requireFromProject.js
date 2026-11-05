/**
 * Load an optional peer the way a config plugin must: from the APP first.
 *
 * A peer dependency belongs to the app that installs it. Under Bun's isolated
 * linker (`peer = false`, see the repo's bunfig.toml) a workspace-linked preset
 * cannot see the app's packages from its own directory, so a plain `require`
 * here throws even when the app has the peer installed. Resolving from the
 * app's project root first, then falling back to the preset's own resolution,
 * works under both an isolated and a hoisted install.
 *
 * @param {string} specifier  Module specifier, e.g. `expo-build-properties`.
 * @param {string | undefined} projectRoot  The app's directory.
 */
function requireFromProject(specifier, projectRoot) {
  return require(resolveFromProject(specifier, projectRoot));
}

/**
 * The file `requireFromProject` would load, resolved the same way.
 *
 * @param {string} specifier
 * @param {string | undefined} projectRoot
 */
function resolveFromProject(specifier, projectRoot) {
  if (projectRoot) {
    try {
      return require.resolve(specifier, { paths: [projectRoot] });
    } catch {
      // Fall through to the preset's own resolution.
    }
  }
  return require.resolve(specifier);
}

/**
 * The app's project root for a config: `_internal.projectRoot` when Expo
 * provides it, else the working directory Expo evaluates config plugins in.
 *
 * @param {{ _internal?: { projectRoot?: string } } | undefined} config
 */
function projectRootOf(config) {
  return config?._internal?.projectRoot ?? process.cwd();
}

module.exports = { requireFromProject, resolveFromProject, projectRootOf };
