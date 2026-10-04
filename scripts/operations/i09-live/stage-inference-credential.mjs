/** One-shot-only staging of the unchanged Alia source factory compilation.
 * No original image module is changed, no require cache is replaced, and no
 * database connection is created here. The ECS launcher separately pins the
 * original image and published SDK dependencies before calling this helper.
 */
import { createHash } from 'node:crypto';
import { constants, openSync, writeFileSync, fsyncSync, closeSync, lstatSync,
  readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const FACTORY_SHA256 = 'e285c443351502cd28a237fecd0d3c6e7eb672353370b5f6d691d0026ec61641';
export const FACTORY_FILENAME = `oxy1519-${FACTORY_SHA256}-oxy-inference-credential.js`;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw new Error('inference_factory_staging_rejected'); };

export function stageInferenceCredential({ apiPackage, source }) {
  if (typeof apiPackage !== 'string' || !Buffer.isBuffer(source)
      || digest(source) !== FACTORY_SHA256) fail();
  const packagePath = resolve(apiPackage);
  if (realpathSync(packagePath) !== packagePath || !lstatSync(packagePath).isFile()) fail();
  const directory = dirname(packagePath);
  if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) fail();
  const helperPath = join(directory, FACTORY_FILENAME);
  let fd;
  let owned;
  try {
    fd = openSync(helperPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    owned = lstatSync(helperPath);
    writeFileSync(fd, source);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    verify();
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    // A partial write belongs to us only if this exact inode still exists.
    if (owned) {
      const current = lstatSync(helperPath);
      if (current.isFile() && current.dev === owned.dev && current.ino === owned.ino) unlinkSync(helperPath);
    }
    throw error;
  }
  function verify() {
    const current = lstatSync(helperPath);
    if (!current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino
        || current.uid !== owned.uid || (current.mode & 0o777) !== 0o400
        || realpathSync(directory) !== directory || digest(readFileSync(helperPath)) !== FACTORY_SHA256) fail();
  }
  let cleaned = false;
  return {
    helperPath,
    cleanup() {
      if (cleaned) return;
      verify();
      unlinkSync(helperPath);
      cleaned = true;
    },
  };
}
