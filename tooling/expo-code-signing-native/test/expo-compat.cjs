/** Independent public-API compatibility checks. Synthetic keys stay in memory. */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const test = require("node:test");
const expo = require("../index.cjs");
const pair = expo.generateKeyPair();
const other = expo.generateKeyPair();
const pem = expo.convertKeyPairToPEM(pair);
const now = Date.now();
const certOptions = {
	keyPair: pair,
	commonName: "Independent synthetic Expo review",
	validityNotBefore: new Date(now - 60_000),
	validityNotAfter: new Date(now + 86_400_000),
};
const certificate = expo.convertCertificatePEMToCertificate(
	expo.convertCertificateToCertificatePEM(
		expo.generateSelfSignedCodeSigningCertificate(certOptions),
	),
);
const message = Buffer.from(
	'{"runtimeVersion":"synthetic-review","id":"fixture"}',
);
const signature = expo.signBufferRSASHA256AndVerify(
	pair.privateKey,
	certificate,
	message,
);
const csr = expo.generateCSR(other, "Independent synthetic development CSR");

test("RSA pair has the default 2048-bit modulus and matching public exponent", () => {
	assert.equal(pair.publicKey.n.bitLength(), 2048);
	assert(pair.publicKey.n.equals(pair.privateKey.n));
	assert(pair.publicKey.e.equals(pair.privateKey.e));
});
test("key-pair PEM round trip preserves both moduli", () => {
	const restored = expo.convertKeyPairPEMToKeyPair(pem);
	assert(restored.publicKey.n.equals(pair.publicKey.n));
	assert(restored.privateKey.n.equals(pair.privateKey.n));
});
test("public-key PEM round trip preserves exponent and modulus", () => {
	const restored = expo.convertPublicKeyPEMToPublicKey(pem.publicKeyPEM);
	assert(restored.n.equals(pair.publicKey.n));
	assert(restored.e.equals(pair.publicKey.e));
});
test("private-key PEM round trip preserves private exponent", () => {
	assert(
		expo
			.convertPrivateKeyPEMToPrivateKey(pem.privateKeyPEM)
			.d.equals(pair.privateKey.d),
	);
});
test("certificate PEM round trip verifies its self-signature", () => {
	assert.equal(certificate.verify(certificate), true);
	assert.equal(
		certificate.subject.getField("CN").value,
		certOptions.commonName,
	);
});
test("valid certificate and corresponding pair satisfy Expo validation", () => {
	assert.doesNotThrow(() =>
		expo.validateSelfSignedCertificate(certificate, pair),
	);
});
test("Expo manifest signature verifies with independent Node/OpenSSL SHA256", () => {
	assert(
		crypto.verify(
			"RSA-SHA256",
			message,
			pem.publicKeyPEM,
			Buffer.from(signature, "base64"),
		),
	);
});
test("altered manifest bytes fail independent Node/OpenSSL verification", () => {
	assert.equal(
		crypto.verify(
			"RSA-SHA256",
			Buffer.concat([message, Buffer.from("!")]),
			pem.publicKeyPEM,
			Buffer.from(signature, "base64"),
		),
		false,
	);
});
test("private key from another pair is rejected by Expo signing verification", () => {
	assert.throws(
		() =>
			expo.signBufferRSASHA256AndVerify(other.privateKey, certificate, message),
		Error,
	);
});
test("reversed certificate validity interval is rejected", () => {
	assert.throws(
		() =>
			expo.generateSelfSignedCodeSigningCertificate({
				...certOptions,
				validityNotBefore: new Date(now + 60_000),
				validityNotAfter: new Date(now),
			}),
		/must be later/,
	);
});
test("expired certificate is rejected by Expo validation", () => {
	const expired = expo.convertCertificatePEMToCertificate(
		expo.convertCertificateToCertificatePEM(
			expo.generateSelfSignedCodeSigningCertificate({
				...certOptions,
				validityNotBefore: new Date(now - 86_400_000),
				validityNotAfter: new Date(now - 60_000),
			}),
		),
	);
	assert.throws(
		() => expo.validateSelfSignedCertificate(expired, pair),
		/validity expired/,
	);
});
test("CSR PEM round trip verifies its signature and requested identity", () => {
	const restored = expo.convertCSRPEMToCSR(expo.convertCSRToCSRPEM(csr));
	assert.equal(restored.verify(), true);
	assert.equal(
		restored.subject.getField("CN").value,
		"Independent synthetic development CSR",
	);
});
test("development certificate verifies its issuer and contains requested project scope", () => {
	const dev = expo.generateDevelopmentCertificateFromCSR(
		pair.privateKey,
		certificate,
		csr,
		"00000000-0000-4000-8000-000000000001",
		"@synthetic/review",
	);
	assert.equal(certificate.verify(dev), true);
	assert(dev.publicKey.n.equals(other.publicKey.n));
	assert.equal(
		dev.getExtension({ id: expo.expoProjectInformationOID }).value,
		"00000000-0000-4000-8000-000000000001,@synthetic/review",
	);
});
test("tampered CSR signature is rejected before development certificate issuance", () => {
	const altered = expo.convertCSRPEMToCSR(expo.convertCSRToCSRPEM(csr));
	altered.signature =
		String.fromCharCode(altered.signature.charCodeAt(0) ^ 1) +
		altered.signature.slice(1);
	assert.throws(() =>
		expo.generateDevelopmentCertificateFromCSR(
			pair.privateKey,
			certificate,
			altered,
			"synthetic",
			"synthetic",
		),
	);
});
