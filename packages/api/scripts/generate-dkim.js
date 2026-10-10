#!/usr/bin/env node

/**
 * DKIM Key Generation Script
 *
 * Generates an RSA key pair for DKIM email signing and outputs:
 * 1. A private key file (dkim-private.pem)
 * 2. The DNS TXT record value to add to your domain
 * 3. Safe env var setup instructions (without printing secret material by default)
 *
 * Usage:
 *   node packages/api/scripts/generate-dkim.js
 *   node packages/api/scripts/generate-dkim.js --selector=mail --domain=oxy.so --output=./keys
 *   node packages/api/scripts/generate-dkim.js --print-private-key  # Explicitly print secret material
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Parse CLI args
const args = {};
process.argv.slice(2).forEach((arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  args[key] = value || true;
});

const selector = args.selector || process.env.DKIM_SELECTOR || 'default';
const domain = args.domain || process.env.EMAIL_DOMAIN || 'oxy.so';
const outputDir = args.output || process.cwd();
const shouldPrintPrivateKey =
  args['print-private-key'] === true || args['print-private-key'] === 'true';

console.log('');
console.log('=== DKIM Key Generator for Oxy Email ===');
console.log('');
console.log(`Domain:   ${domain}`);
console.log(`Selector: ${selector}`);
console.log(`Output:   ${outputDir}`);
console.log('');

// Generate 2048-bit RSA key pair
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem',
  },
  privateKeyEncoding: {
    type: 'pkcs1',
    format: 'pem',
  },
});

// Write private key to file
const privateKeyPath = path.join(outputDir, 'dkim-private.pem');
fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
console.log(`Private key written to: ${privateKeyPath}`);
console.log('');

// Extract the base64 portion of the public key (strip PEM headers)
const pubKeyBase64 = publicKey
  .replace(/-----BEGIN PUBLIC KEY-----/, '')
  .replace(/-----END PUBLIC KEY-----/, '')
  .replace(/\s/g, '');

// DNS TXT record value
const dnsRecord = `v=DKIM1; k=rsa; p=${pubKeyBase64}`;

console.log('=== DNS Record ===');
console.log('');
console.log('Add this TXT record to your DNS:');
console.log('');
console.log(`  Name:  ${selector}._domainkey.${domain}`);
console.log(`  Type:  TXT`);
console.log(`  Value: ${dnsRecord}`);
console.log('');

// If the value is too long for a single TXT record (>255 chars),
// some DNS providers need it split into 255-char chunks
if (dnsRecord.length > 255) {
  console.log('NOTE: This value exceeds 255 characters. Some DNS providers');
  console.log('require it to be split into multiple quoted strings:');
  console.log('');
  const chunks = [];
  let remaining = dnsRecord;
  while (remaining.length > 0) {
    chunks.push(remaining.substring(0, 255));
    remaining = remaining.substring(255);
  }
  console.log(`  Value: ${chunks.map((c) => `"${c}"`).join(' ')}`);
  console.log('');
}

console.log('=== Environment Variable ===');
console.log('');
console.log('Set DKIM_PRIVATE_KEY from the generated private key file in your secret manager.');
console.log('');
console.log('Example for local shells:');
console.log('');
console.log(`  export DKIM_PRIVATE_KEY=$(cat ${privateKeyPath})`);
console.log('');
if (shouldPrintPrivateKey) {
  console.log('WARNING: --print-private-key prints secret DKIM signing material to stdout.');
  console.log('Only use this in a trusted, non-logged terminal.');
  console.log('');
  const escaped = privateKey.replace(/\n/g, '\\n').replace(/\r/g, '');
  console.log(`  DKIM_PRIVATE_KEY="${escaped}"`);
  console.log('');
} else {
  console.log('Secret material was not printed. Re-run with --print-private-key only if you');
  console.log('must copy the value manually and your terminal output is not logged.');
  console.log('');
}

console.log('=== Other Required DNS Records ===');
console.log('');
console.log(`1. MX Record (receives mail):`);
console.log(`   Name: ${domain}    Type: MX    Value: 10 mail.${domain}.`);
console.log('');
console.log(`2. A Record (mail server IP):`);
console.log(`   Name: mail.${domain}    Type: A    Value: YOUR_SERVER_IP`);
console.log('');
console.log(`3. SPF Record (authorizes your IP to send):`);
console.log(`   Name: ${domain}    Type: TXT    Value: v=spf1 ip4:YOUR_SERVER_IP -all`);
console.log('');
console.log(`4. DMARC Record (policy for failed checks):`);
console.log(
  `   Name: _dmarc.${domain}    Type: TXT    Value: v=DMARC1; p=reject; rua=mailto:dmarc@${domain}`,
);
console.log('');
console.log(`5. Reverse DNS / PTR (set via your hosting provider):`);
console.log(`   YOUR_SERVER_IP → mail.${domain}`);
console.log('');
console.log('=== Done ===');
console.log('');
console.log('After setting up DNS records, verify with:');
console.log(`  dig TXT ${selector}._domainkey.${domain}`);
console.log(`  dig MX ${domain}`);
console.log(`  dig TXT ${domain}`);
console.log('');
console.log('Test your email deliverability at: https://www.mail-tester.com');
console.log('');
