/**
 * One-shot keygen for Oxy Updates code signing.
 *
 * Generates an RSA keypair + a self-signed code-signing certificate (the same
 * `@expo/code-signing-certificates` machinery the expo-updates client verifies
 * against), then:
 *   - prints the BASE64-ENCODED private-key PEM to stdout — paste this into the
 *     GitHub Actions secret / SSM `/oxy/oxy-api/UPDATES_CODE_SIGNING_PRIVATE_KEY`
 *     (the value `services/updates/signing.service.ts` decodes at runtime);
 *   - writes the PUBLIC certificate PEM to the given output path — commit this
 *     certificate into each app that receives updates (expo-updates
 *     `codeSigningCertificate`), NEVER the private key.
 *
 * The private key is NEVER written to disk in the repo. Run it locally, capture
 * the base64 line into the secret store, and discard the terminal scrollback.
 *
 *   bun scripts/generate-updates-code-signing.ts <certificate-output-path>
 *
 * e.g. `bun scripts/generate-updates-code-signing.ts ./updates-certificate.pem`
 */

import { promises as fs } from 'fs';
import path from 'path';
import {
  generateKeyPair,
  generateSelfSignedCodeSigningCertificate,
  convertCertificateToCertificatePEM,
  convertKeyPairToPEM,
} from '@expo/code-signing-certificates';

const CERTIFICATE_COMMON_NAME = 'Oxy Updates Code Signing';
const CERTIFICATE_VALIDITY_YEARS = 10;

async function main(): Promise<void> {
  const certOutputArg = process.argv[2] ?? './updates-code-signing-certificate.pem';
  const certOutputPath = path.resolve(process.cwd(), certOutputArg);

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

  await fs.writeFile(certOutputPath, certificatePEM, { encoding: 'utf8' });

  const privateKeyBase64 = Buffer.from(privateKeyPEM, 'utf8').toString('base64');

  process.stdout.write('\n');
  process.stdout.write('=== Oxy Updates code-signing keypair generated ===\n\n');
  process.stdout.write(`Public certificate written to: ${certOutputPath}\n`);
  process.stdout.write('  → commit this certificate into each app that receives updates.\n\n');
  process.stdout.write(
    'UPDATES_CODE_SIGNING_PRIVATE_KEY (base64 PEM — set as a secret, never commit):\n\n',
  );
  process.stdout.write(`${privateKeyBase64}\n\n`);
  process.stdout.write(
    'Store the value above in GitHub Actions secrets → SSM /oxy/oxy-api/UPDATES_CODE_SIGNING_PRIVATE_KEY.\n',
  );
  process.stdout.write(
    'The private key was NOT written to disk. Clear your terminal scrollback.\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Failed to generate code-signing keypair: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
