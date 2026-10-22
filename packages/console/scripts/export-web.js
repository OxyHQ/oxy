/**
 * Wrapper for `bun x expo export --platform web` that handles Expo CLI
 * hanging after export completes.
 *
 * Strategy: spawn the export in a detached process group, watch stdout for
 * "Exported:" (which means the static files are written), then SIGKILL the
 * entire process group and exit 0.
 *
 * See: https://github.com/expo/expo/issues/27938
 */

const { spawn } = require('child_process');
const path = require('path');

const EXPORT_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes hard limit (DO build instances are slow)
const projectRoot = path.resolve(__dirname, '..');

const child = spawn('bun', ['x', 'expo', 'export', '--platform', 'web'], {
  cwd: projectRoot,
  stdio: ['inherit', 'pipe', 'pipe'],
  detached: true, // new process group so we can kill the whole tree
});

let done = false;

function finish(code) {
  if (done) return;
  done = true;
  try {
    process.kill(-child.pid, 'SIGKILL'); // kill entire process group
  } catch (err) {
    // ESRCH means the group already exited — only worth surfacing other failures.
    if (err && err.code !== 'ESRCH') {
      console.error('export-web cleanup failed:', err);
    }
  }
  process.exit(code);
}

child.stdout.on('data', (data) => {
  process.stdout.write(data);
  if (data.toString().includes('Exported:')) {
    console.log('\nExport completed. Killing hung process group.');
    finish(0);
  }
});

child.stderr.on('data', (data) => {
  process.stderr.write(data);
});

child.on('exit', (code) => {
  if (!done) {
    // Process exited on its own (no hang) — rely on Expo's exit status.
    if (code === 0) {
      finish(0);
    } else {
      console.error(`\nExport failed with exit code ${code}`);
      finish(1);
    }
  }
});

child.on('error', (err) => {
  console.error('\nFailed to start export:', err.message);
  finish(1);
});

setTimeout(() => {
  if (!done) {
    console.error('\nExport timed out after 8 minutes.');
    finish(1);
  }
}, EXPORT_TIMEOUT_MS);
