/** One-shot-only staging of the reviewed canonical canary compilation.
 * No original image module is changed, no require cache is replaced, and no
 * database connection is created here. The ECS launcher separately pins the
 * original image and canonical dependencies before calling this helper.
 */
import { createHash } from 'node:crypto';
import { constants, openSync, writeFileSync, fsyncSync, closeSync, lstatSync,
  readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const CANARY_MODULE_SHA256 = '2977ad4b30cd33bbce2a0a8b2faa3c3f16838d7dc06f72d8cc324a8ea64343d6';
export const CANARY_MODULE_FILENAME = `alia-canary-operational-${CANARY_MODULE_SHA256}.cjs`;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw new Error('canary_module_staging_rejected'); };

export function stageAliaCanaryModule({ apiPackage, source }) {
  if (typeof apiPackage !== 'string' || !Buffer.isBuffer(source)
      || digest(source) !== CANARY_MODULE_SHA256) fail();
  const packagePath = resolve(apiPackage);
  if (realpathSync(packagePath) !== packagePath || !lstatSync(packagePath).isFile()) fail();
  const directory = join(dirname(packagePath), 'dist', 'services');
  if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) fail();
  const canaryModulePath = join(directory, CANARY_MODULE_FILENAME);
  let fd;
  let owned;
  try {
    fd = openSync(canaryModulePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    owned = lstatSync(canaryModulePath);
    writeFileSync(fd, source);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    verify();
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    // A partial write belongs to us only if this exact inode still exists.
    if (owned) {
      const current = lstatSync(canaryModulePath);
      if (current.isFile() && current.dev === owned.dev && current.ino === owned.ino) unlinkSync(canaryModulePath);
    }
    throw error;
  }
  function verify() {
    const current = lstatSync(canaryModulePath);
    if (!current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino
        || current.uid !== owned.uid || (current.mode & 0o777) !== 0o400
        || realpathSync(directory) !== directory || digest(readFileSync(canaryModulePath)) !== CANARY_MODULE_SHA256) fail();
  }
  let cleaned = false;
  return {
    canaryModulePath,
    cleanup() {
      if (cleaned) return;
      verify();
      unlinkSync(canaryModulePath);
      cleaned = true;
    },
  };
}
