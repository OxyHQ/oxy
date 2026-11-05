/**
 * One-shot keygen for Oxy Updates code signing.
 *
 * Generates an RSA keypair + a self-signed code-signing certificate (the same
 * `@expo/code-signing-certificates` machinery the expo-updates client verifies
 * against), then:
 *   - writes the PUBLIC certificate PEM to `<certificate-output-path>`. It is
 *     committed ONCE, into `@oxy.so/app-preset` (`certs/oxy-updates-code-signing.pem`),
 *     where `withOxyUpdates` bakes it into every OTA-enabled binary;
 *   - writes the BASE64-ENCODED private-key PEM (the value
 *     `services/updates/signing.service.ts` decodes at runtime) to
 *     `<private-key-output-path>`, created with mode 0600. That path must be
 *     OUTSIDE every git checkout. The key goes from that file into SSM
 *     (`/oxy/oxy-api/UPDATES_CODE_SIGNING_PRIVATE_KEY`, SecureString) with
 *     `--value file://<path>`, so it is never typed, echoed or pasted.
 *
 * The private key is never printed. The script refuses an existing private-key
 * file (it would silently replace the key a binary already trusts) and a path
 * inside a git work tree.
 *
 *   bun scripts/generate-updates-code-signing.ts <certificate-output-path> <private-key-output-path>
 *
 * The full procedure, including the SSM write and the rotation rules, is in
 * `packages/app-preset/certs/README.md`.
 */

import { existsSync, promises as fs } from 'fs';
import path from 'path';
import {
  convertCertificateToCertificatePEM,
  convertKeyPairToPEM,
  generateKeyPair,
  generateSelfSignedCodeSigningCertificate,
} from '@expo/code-signing-certificates';

const CERTIFICATE_COMMON_NAME = 'Oxy Updates Code Signing';
const CERTIFICATE_VALIDITY_YEARS = 10;

/** True when `target` (a file that may not exist yet) sits inside a git work tree. */
function isInsideGitWorkTree(target: string): boolean {
  let dir = path.dirname(target);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}

async function main(): Promise<void> {
  const [certOutputArg, keyOutputArg] = process.argv.slice(2);
  if (!certOutputArg || !keyOutputArg) {
    throw new Error(
      'usage: bun scripts/generate-updates-code-signing.ts <certificate-output-path> <private-key-output-path>',
    );
  }
  const certOutputPath = path.resolve(process.cwd(), certOutputArg);
  const keyOutputPath = path.resolve(process.cwd(), keyOutputArg);

  if (isInsideGitWorkTree(keyOutputPath)) {
    throw new Error(
      `refusing to write the private key inside a git work tree (${keyOutputPath}); ` +
        'choose a path outside every checkout, e.g. ~/.config/oxy/',
    );
  }
  if (existsSync(keyOutputPath)) {
    throw new Error(
      `refusing to overwrite ${keyOutputPath}: it may hold the key shipped binaries trust. ` +
        'Rotation is a deliberate procedure (certs/README.md, "Rotation").',
    );
  }

  const keyPair = generateKeyPair();

  const validityNotBefore = new Date();
  const validityNotAfter = new Date();
  validityNotAfter.setFullYear(validityNotAfter.getFullYear() + CERTIFICATE_VALIDITY_YEARS);

  const certificate = generateSelfSignedCodeSigningCertificate({
    keyPair,
    validityNotBefore,
    validityNotAfter,
    commonName: CERTIFICATE_COMMON_NAME,
  });

  const { privateKeyPEM } = convertKeyPairToPEM(keyPair);
  const certificatePEM = convertCertificateToCertificatePEM(certificate);
  const privateKeyBase64 = Buffer.from(privateKeyPEM, 'utf8').toString('base64');

  await fs.mkdir(path.dirname(keyOutputPath), { recursive: true, mode: 0o700 });
  // `wx`: fail if it appeared since the check above; 0600 from creation, never chmod'ed later.
  await fs.writeFile(keyOutputPath, privateKeyBase64, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await fs.writeFile(certOutputPath, certificatePEM, { encoding: 'utf8' });

  process.stdout.write('Oxy Updates code-signing keypair generated.\n');
  process.stdout.write(`  public certificate: ${certOutputPath} (commit it)\n`);
  process.stdout.write(
    `  private key (base64 PEM, mode 0600): ${keyOutputPath} (never commit it)\n`,
  );
  process.stdout.write(
    'Next: aws ssm put-parameter --type SecureString --name ' +
      `/oxy/oxy-api/UPDATES_CODE_SIGNING_PRIVATE_KEY --value file://${keyOutputPath}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Failed to generate code-signing keypair: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
