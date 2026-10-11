/** Private, non-overwriting files for an explicitly reviewed operator command. */
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
function privateDirectory(path: string) {
  const dir = lstatSync(dirname(path));
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    (dir.mode & 0o777) !== 0o700 ||
    dir.uid !== process.getuid?.()
  ) {
    throw new Error('private_operator_directory_required');
  }
}
function syncDirectory(path: string) {
  const fd = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function reservePrivateFile(path: string) {
  privateDirectory(path);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    syncDirectory(path);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}
export function writePrivateJson(fd: number, value: unknown) {
  writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  fsyncSync(fd);
}
export function readPrivateFile(path: string): Buffer {
  privateDirectory(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 65_536
    ) {
      throw new Error('private_operator_file_required');
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
