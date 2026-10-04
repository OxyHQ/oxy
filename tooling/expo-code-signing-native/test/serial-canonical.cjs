"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const pki = require("../index.cjs");
const pair = pki.generateKeyPair();
const csr = pki.generateCSR(pair, "Synthetic canonical serial CSR");
const options = {
  keyPair: pair,
  commonName: "Synthetic canonical serial issuer",
  validityNotBefore: new Date("2026-10-01T00:00:00Z"),
  validityNotAfter: new Date("2026-11-01T00:00:00Z"),
};
for (const [name, entropy, expected] of [
  ["redundant leading zero", "000102030405060708", "0102030405060708"],
  ["multiple leading zeros", "000000000000000001", "01"],
  ["required sign padding", "008002030405060708", "008002030405060708"],
  ["all-zero entropy remains nonzero", "000000000000000000", "01"],
  ["high entropy remains positive", "ffffffffffffffffff", "7fffffffffffffffff"],
]) {
  test(`both certificate issuers encode a canonical positive serial: ${name}`, (t) => {
    t.mock.method(crypto, "randomBytes", (size) => {
      assert.equal(size, 9);
      return Buffer.from(entropy, "hex");
    });
    const issuer = pki.generateSelfSignedCodeSigningCertificate(options);
    const development = pki.generateDevelopmentCertificateFromCSR(
      pair.privateKey, issuer, csr, "synthetic-project", "@synthetic/serial",
    );
    for (const certificate of [issuer, development]) {
      const native = new crypto.X509Certificate(certificate.raw);
      assert.equal(Buffer.from(certificate.model.tbsCertificate.serialNumber).toString("hex"), expected);
      assert.equal(native.verify(pair.publicKey.keyObject), true);
      assert.equal(issuer.verify(certificate), true);
    }
  });
}
