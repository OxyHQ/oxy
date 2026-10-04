"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { AsnParser, AsnSerializer } = require("@peculiar/asn1-schema");
const x = require("@peculiar/asn1-x509");
const c = require("@peculiar/asn1-csr");
const pki = require("../index.cjs");
const pair = pki.generateKeyPair();
const pem = pki.convertKeyPairToPEM(pair);
const csr = pki.generateCSR(pair, "Independent native standards");
const csrPEM = pki.convertCSRToCSRPEM(csr);
const now = new Date();
const cert = pki.generateSelfSignedCodeSigningCertificate({
	keyPair: pair,
	validityNotBefore: new Date(now - 60000),
	validityNotAfter: new Date(+now + 86400000),
	commonName: "Independent native standards",
});
const certPEM = pki.convertCertificateToCertificatePEM(cert);
const raw = (value) => Buffer.from(value);
const der = (value) => raw(AsnSerializer.serialize(value));
const exportCSR = (bytes) =>
	`-----BEGIN CERTIFICATE REQUEST-----\n${raw(bytes)
		.toString("base64")
		.match(/.{1,64}/g)
		.join("\n")}\n-----END CERTIFICATE REQUEST-----\n`;
let scratch;
test.before(() => {
	scratch = fs.mkdtempSync(path.join(os.tmpdir(), "oxy-native-pki-"));
	fs.writeFileSync(path.join(scratch, "key.pem"), pem.privateKeyPEM, {
		mode: 0o600,
	});
	fs.writeFileSync(path.join(scratch, "request.pem"), csrPEM);
	fs.writeFileSync(path.join(scratch, "certificate.pem"), certPEM);
});
test.after(() => {
	fs.rmSync(scratch, { force: true, recursive: true });
});
test("native CSR verifies using system OpenSSL independently", () => {
	const out = execFileSync(
		"openssl",
		["req", "-verify", "-in", path.join(scratch, "request.pem"), "-noout"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	assert.match(out, /Certificate request self-signature verify OK/);
});
test("system OpenSSL CSR retains CN/O/OU and verifies using native implementation", () => {
	const openssl = execFileSync(
		"openssl",
		[
			"req",
			"-new",
			"-sha256",
			"-key",
			path.join(scratch, "key.pem"),
			"-subj",
			"/CN=Independent OpenSSL/O=Fixture Organization/OU=Fixture Unit",
		],
		{ encoding: "utf8" },
	);
	const parsed = pki.convertCSRPEMToCSR(openssl);
	assert(parsed.verify());
	assert.equal(parsed.subject.getField("CN").value, "Independent OpenSSL");
	assert.equal(parsed.subject.getField("O").value, "Fixture Organization");
	assert.equal(parsed.subject.getField("OU").value, "Fixture Unit");
});
test("system OpenSSL reads native certificate code-signing critical extensions", () => {
	const text = execFileSync(
		"openssl",
		["x509", "-in", path.join(scratch, "certificate.pem"), "-noout", "-text"],
		{ encoding: "utf8" },
	);
	assert.match(text, /X509v3 Key Usage: critical/);
	assert.match(text, /Digital Signature/);
	assert.match(text, /X509v3 Extended Key Usage: critical/);
	assert.match(text, /Code Signing/);
});
test("native certificate is accepted as its exact self-signed OpenSSL trust anchor", () => {
	const out = execFileSync(
		"openssl",
		[
			"verify",
			"-CAfile",
			path.join(scratch, "certificate.pem"),
			path.join(scratch, "certificate.pem"),
		],
		{ encoding: "utf8" },
	);
	assert.match(out, /: OK/);
});
test("trailing CSR ASN1 value is refused before signature validation", () => {
	const bytes = Buffer.concat([der(csr.model), Buffer.from("0500", "hex")]);
	assert.throws(() => pki.convertCSRPEMToCSR(exportCSR(bytes)));
});
test("nested extra CSR signature algorithm field is refused", () => {
	const asn = require("asn1js");
	const sequence = asn.fromBER(der(csr.model)).result;
	sequence.valueBlock.value[1].valueBlock.value.push(new asn.Null());
	assert.throws(() => pki.convertCSRPEMToCSR(exportCSR(sequence.toBER(false))));
});
test("nonempty NULL CSR algorithm parameter is refused on actual DER bytes", () => {
	const bytes = der(csr.model);
	const encodedAlgorithm = Buffer.from("300d06092a864886f70d01010b0500", "hex");
	const offset = bytes.indexOf(encodedAlgorithm);
	assert(offset > 0);
	const bad = Buffer.concat([
		bytes.subarray(0, offset),
		Buffer.from("300e06092a864886f70d01010b050100", "hex"),
		bytes.subarray(offset + encodedAlgorithm.length),
	]);
	const width = bad[1] & 0x7f;
	assert(bad[1] & 0x80);
	bad.writeUIntBE(bytes.readUIntBE(2, width) + 1, 2, width);
	assert.throws(() => pki.convertCSRPEMToCSR(exportCSR(bad)));
});
test("unknown CSR algorithm is refused even with unchanged signature", () => {
	const model = new c.CertificationRequest({
		...csr.model,
		signatureAlgorithm: new x.AlgorithmIdentifier({
			algorithm: "1.2.3.4.5",
			parameters: null,
		}),
	});
	assert.throws(() => pki.convertCSRPEMToCSR(exportCSR(der(model))));
});
test("CSR signature bit mutation stays denied before issuance", () => {
	const value = pki.convertCSRPEMToCSR(csrPEM);
	value.signature =
		String.fromCharCode(value.signature.charCodeAt(0) ^ 1) +
		value.signature.slice(1);
	assert.equal(value.verify(), false);
	assert.throws(() =>
		pki.generateDevelopmentCertificateFromCSR(
			pair.privateKey,
			cert,
			value,
			"fixture-app",
			"fixture-scope",
		),
	);
});
test("PEM with a second object is refused", () =>
	assert.throws(() => pki.convertCSRPEMToCSR(csrPEM + csrPEM)));
test("invalid base64 padding is refused", () =>
	assert.throws(() =>
		pki.convertCSRPEMToCSR(csrPEM.replace("-----END", "!-----END")),
	));
test("wrong public/private key pair is refused by validation", () => {
	const other = pki.generateKeyPair();
	assert.throws(() =>
		pki.validateSelfSignedCertificate(cert, {
			publicKey: pair.publicKey,
			privateKey: other.privateKey,
		}),
	);
});
const message = Buffer.from(
	"Independent native PKCS1 known-key test, no customer data",
);
const digest = crypto.createHash("sha256").update(message).digest();
const tlv = (tag, bytes) =>
	Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
const oid = Buffer.from("608648016503040201", "hex");
function malformedSignature(variant) {
	let alg = Buffer.concat([tlv(6, oid), tlv(5, Buffer.alloc(0))]);
	if (variant === "extra-nested")
		alg = Buffer.concat([alg, tlv(5, Buffer.alloc(0))]);
	if (variant === "nonempty-null")
		alg = Buffer.concat([tlv(6, oid), tlv(5, Buffer.from([0]))]);
	let info = tlv(48, Buffer.concat([tlv(48, alg), tlv(4, digest)]));
	if (variant === "trailing")
		info = Buffer.concat([info, tlv(5, Buffer.alloc(0))]);
	const padding = Buffer.alloc(256 - info.length - 3, 255);
	const encoded = Buffer.concat([
		Buffer.from([0, 1]),
		padding,
		Buffer.from([0]),
		info,
	]);
	return crypto.privateEncrypt(
		{
			key: pair.privateKey.keyObject,
			padding: crypto.constants.RSA_NO_PADDING,
		},
		encoded,
	);
}
for (const variant of [
	"canonical",
	"extra-nested",
	"nonempty-null",
	"trailing",
])
	test(`OpenSSL RSA verifier ${variant === "canonical" ? "accepts" : "rejects"} known-key ${variant} DigestInfo`, () => {
		const sig = malformedSignature(variant);
		assert.equal(
			crypto.verify(
				"sha256",
				message,
				{
					key: pair.publicKey.keyObject,
					padding: crypto.constants.RSA_PKCS1_PADDING,
				},
				sig,
			),
			variant === "canonical",
		);
	});

test("certificate trailing DER cannot influence its parsed subject", () => {
	const bytes = Buffer.concat([cert.raw, Buffer.from("0500", "hex")]);
	const malformed = `-----BEGIN CERTIFICATE-----\n${bytes.toString("base64")}\n-----END CERTIFICATE-----\n`;
	assert.throws(() => pki.convertCertificatePEMToCertificate(malformed));
});
test("mutated certificate signature cannot pass self-signed validation", () => {
	const bytes = Buffer.from(cert.raw);
	bytes[bytes.length - 1] ^= 1;
	const malformed = `-----BEGIN CERTIFICATE-----\n${bytes.toString("base64")}\n-----END CERTIFICATE-----\n`;
	const parsed = pki.convertCertificatePEMToCertificate(malformed);
	assert.throws(() => pki.validateSelfSignedCertificate(parsed, pair));
});
test("unpaired UTF16 common name is refused before certificate issuance", () => {
	assert.throws(() => pki.generateCSR(pair, "\ud800"));
});

test("actual forked Expo Security.js reads an OpenSSL EC certificate DN", async () => {
	const vm = require("node:vm");
	const keyPath = path.join(scratch, "ec-key.pem");
	fs.writeFileSync(
		keyPath,
		crypto
			.generateKeyPairSync("ec", { namedCurve: "prime256v1" })
			.privateKey.export({ format: "pem", type: "pkcs8" }),
		{ mode: 0o600 },
	);
	const ecCertificate = execFileSync(
		"openssl",
		[
			"req",
			"-new",
			"-x509",
			"-sha256",
			"-key",
			keyPath,
			"-subj",
			"/CN=Apple Development Fixture/O=Fixture Organization/OU=FIXTURETEAM",
			"-days",
			"1",
		],
		{ encoding: "utf8" },
	);
	const archive = path.resolve(
		__dirname,
		"../../../vendor/expo-native/oxy.so-expo-cli-native-57.0.23+oxy.native.1.tgz",
	);
	const source = execFileSync(
		"tar",
		["-xOf", archive, "package/build/src/run/ios/codeSigning/Security.js"],
		{ encoding: "utf8" },
	);
	const exports = {};
	const requireFixture = (id) => {
		if (id === "@expo/code-signing-certificates") return pki;
		if (id === "@expo/spawn-async")
			return async (command, args) => {
				assert.equal(command, "security");
				assert.deepEqual(Array.from(args), [
					"find-certificate",
					"-c",
					"FIXTURETEAM",
					"-p",
				]);
				return { stdout: ecCertificate };
			};
		if (id.endsWith("SecurityBinPrerequisite"))
			return {
				SecurityBinPrerequisite: { instance: { assertAsync: async () => {} } },
			};
		if (id.endsWith("/errors"))
			return { CommandError: class CommandError extends Error {} };
		throw Error(`Unreviewed Security.js dependency: ${id}`);
	};
	vm.runInNewContext(
		source,
		{ exports, require: requireFixture },
		{ filename: "reviewed-Expo-Security.js" },
	);
	const value = await exports.resolveCertificateSigningInfoAsync("FIXTURETEAM");
	assert.equal(value.signingCertificateId, "FIXTURETEAM");
	assert.equal(value.codeSigningInfo, "Apple Development Fixture");
	assert.equal(value.appleTeamName, "Fixture Organization");
	assert.equal(value.appleTeamId, "FIXTURETEAM");
});
