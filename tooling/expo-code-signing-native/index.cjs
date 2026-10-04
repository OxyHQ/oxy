// Synchronous Expo code-signing adapter over Node/OpenSSL crypto.
// ASN.1 is encoded with maintained schema types, never cryptographic arithmetic.
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
	AsnParser,
	AsnSerializer,
	OctetString,
} = require("@peculiar/asn1-schema");
const x = require("@peculiar/asn1-x509");
const c = require("@peculiar/asn1-csr");
const RSA_SHA256 = "1.2.840.113549.1.1.11";
const EXPO_OID =
	"1.2.840.113556.1.8000.2554.43437.254.128.102.157.7894389.20439.2.1";
const buf = (value) => Buffer.from(value);
const der = (value) => buf(AsnSerializer.serialize(value));
function strictParse(value, Type) {
	const bytes = buf(value);
	if (!bytes.length || bytes.length > 1024 * 1024)
		throw Error("Unsupported DER size");
	const parsed = AsnParser.parse(bytes, Type);
	if (!der(parsed).equals(bytes))
		throw Error("Noncanonical or incomplete DER structure");
	return parsed;
}
function checkedPEM(value) {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 2 * 1024 * 1024
	)
		throw Error("Unsupported PEM input");
	return value.trim();
}
function unpem(value, label) {
	const text = checkedPEM(value);
	const match = new RegExp(
		`^-----BEGIN ${label}-----\\s+([A-Za-z0-9+/=\\s]+)-----END ${label}-----$`,
	).exec(text);
	if (!match) throw Error("Invalid PEM structure");
	const compact = match[1].replace(/\s/g, "");
	const bytes = Buffer.from(compact, "base64");
	if (bytes.toString("base64") !== compact) throw Error("Invalid PEM encoding");
	return bytes;
}
const pem = (label, bytes) =>
	`-----BEGIN ${label}-----\n${buf(bytes)
		.toString("base64")
		.match(/.{1,64}/g)
		.join("\n")}\n-----END ${label}-----\n`;
class PublicInteger {
	constructor(base64url) {
		this.bytes = Buffer.from(base64url, "base64url");
	}
	equals(other) {
		return other instanceof PublicInteger && this.bytes.equals(other.bytes);
	}
	bitLength() {
		const hex = this.bytes.toString("hex");
		return BigInt(`0x${hex}`).toString(2).length;
	}
	toString(radix = 10) {
		return BigInt(`0x${this.bytes.toString("hex")}`).toString(radix);
	}
}
function wrapKey(key) {
	const result = { keyObject: key };
	if (key.asymmetricKeyType === "rsa") {
		const jwk = key.export({ format: "jwk" });
		for (const name of ["n", "e", "d"])
			if (jwk[name]) result[name] = new PublicInteger(jwk[name]);
	}
	return result;
}
function keyObject(value) {
	const key = value?.keyObject;
	if (!key || key.asymmetricKeyType !== "rsa") throw Error("RSA key required");
	return key;
}
const publicObject = (value) => crypto.createPublicKey(keyObject(value));
function generateKeyPair() {
	const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicExponent: 65537,
	});
	return { publicKey: wrapKey(publicKey), privateKey: wrapKey(privateKey) };
}
function convertKeyPairToPEM(pair) {
	return {
		privateKeyPEM: keyObject(pair.privateKey).export({
			format: "pem",
			type: "pkcs1",
		}),
		publicKeyPEM: keyObject(pair.publicKey).export({
			format: "pem",
			type: "pkcs1",
		}),
	};
}
const convertPublicKeyPEMToPublicKey = (value) => {
	const key = wrapKey(crypto.createPublicKey(checkedPEM(value)));
	keyObject(key);
	return key;
};
const convertPrivateKeyPEMToPrivateKey = (value) => {
	const key = wrapKey(crypto.createPrivateKey(checkedPEM(value)));
	keyObject(key);
	return key;
};
const convertKeyPairPEMToKeyPair = ({ privateKeyPEM, publicKeyPEM }) => ({
	privateKey: convertPrivateKeyPEMToPrivateKey(privateKeyPEM),
	publicKey: convertPublicKeyPEMToPublicKey(publicKeyPEM),
});
const OIDS = {
	CN: "2.5.4.3",
	commonName: "2.5.4.3",
	O: "2.5.4.10",
	organizationName: "2.5.4.10",
	OU: "2.5.4.11",
	organizationalUnitName: "2.5.4.11",
	C: "2.5.4.6",
	countryName: "2.5.4.6",
};
function nameView(name) {
	const attributes = Array.from(name).flatMap((rdn) =>
		Array.from(rdn).map((a) => ({
			type: a.type,
			name: Object.keys(OIDS).find((n) => n.length > 2 && OIDS[n] === a.type),
			value: a.value.toString(),
		})),
	);
	return {
		asn: name,
		hash: crypto.createHash("sha256").update(der(name)).digest("hex"),
		attributes,
		getField(field) {
			const name = typeof field === "string" ? field : field?.name;
			return attributes.find((a) => a.type === (OIDS[name] ?? name));
		},
	};
}
function commonName(value) {
	assert(
		typeof value === "string" &&
			value.length > 0 &&
			value.isWellFormed() &&
			!value.includes("\0"),
		"Invalid common name",
	);
	return new x.Name([
		new x.RelativeDistinguishedName([
			new x.AttributeTypeAndValue({
				type: OIDS.CN,
				value: new x.AttributeValue({ utf8String: value }),
			}),
		]),
	]);
}
const algorithm = () =>
	new x.AlgorithmIdentifier({ algorithm: RSA_SHA256, parameters: null });
const spki = (key) =>
	strictParse(
		keyObject(key).export({ format: "der", type: "spki" }),
		x.SubjectPublicKeyInfo,
	);
function extensions(project) {
	const values = [
		new x.Extension({
			extnID: x.id_ce_keyUsage,
			critical: true,
			extnValue: new OctetString(
				der(new x.KeyUsage(x.KeyUsageFlags.digitalSignature)),
			),
		}),
		new x.Extension({
			extnID: x.id_ce_extKeyUsage,
			critical: true,
			extnValue: new OctetString(
				der(new x.ExtendedKeyUsage([x.id_kp_codeSigning])),
			),
		}),
	];
	if (project !== undefined)
		values.push(
			new x.Extension({
				extnID: EXPO_OID,
				extnValue: new OctetString(Buffer.from(project, "utf8")),
			}),
		);
	return new x.Extensions(values);
}
function certificateView(raw) {
	const model = strictParse(raw, x.Certificate);
	const native = new crypto.X509Certificate(buf(raw));
	const tbs = model.tbsCertificate;
	if (!der(tbs.signature).equals(der(model.signatureAlgorithm)))
		throw Error("Certificate signature algorithms disagree");
	const result = {
		model,
		raw: buf(raw),
		publicKey: wrapKey(native.publicKey),
		validity: {
			notBefore: tbs.validity.notBefore.getTime(),
			notAfter: tbs.validity.notAfter.getTime(),
		},
		subject: nameView(tbs.subject),
		issuer: nameView(tbs.issuer),
		getExtension(field) {
			const oid =
				field === "keyUsage"
					? x.id_ce_keyUsage
					: field === "extKeyUsage"
						? x.id_ce_extKeyUsage
						: typeof field === "string"
							? field
							: field?.id;
			const ext = tbs.extensions?.find((v) => v.extnID === oid);
			if (!ext) return null;
			const bytes = ext.extnValue.buffer;
			if (oid === x.id_ce_keyUsage)
				return {
					id: oid,
					name: "keyUsage",
					critical: ext.critical,
					digitalSignature: strictParse(bytes, x.KeyUsage)
						.toJSON()
						.includes("digitalSignature"),
				};
			if (oid === x.id_ce_extKeyUsage)
				return {
					id: oid,
					name: "extKeyUsage",
					critical: ext.critical,
					codeSigning: strictParse(bytes, x.ExtendedKeyUsage).includes(
						x.id_kp_codeSigning,
					),
				};
			return {
				id: oid,
				critical: ext.critical,
				value: buf(bytes).toString("utf8"),
			};
		},
		verify(other) {
			if (other.issuer.hash !== this.subject.hash) return false;
			return new crypto.X509Certificate(other.raw).verify(native.publicKey);
		},
	};
	return result;
}
function issue({
	publicKey,
	privateKey,
	subject,
	issuer,
	notBefore,
	notAfter,
	project,
}) {
	assert(
		notAfter > notBefore,
		"validityNotAfter must be later than validityNotBefore",
	);
	const serial = crypto.randomBytes(9);
	serial[0] &= 0x7f;
	if (serial.every((v) => v === 0)) serial[8] = 1;
	const tbs = new x.TBSCertificate({
		version: 2,
		serialNumber: serial,
		signature: algorithm(),
		issuer,
		subject,
		subjectPublicKeyInfo: spki(publicKey),
		validity: new x.Validity({ notBefore, notAfter }),
		extensions: extensions(project),
	});
	const signature = crypto.sign("sha256", der(tbs), {
		key: keyObject(privateKey),
		padding: crypto.constants.RSA_PKCS1_PADDING,
	});
	const cert = new x.Certificate({
		tbsCertificate: tbs,
		signatureAlgorithm: algorithm(),
		signatureValue: signature,
	});
	return certificateView(der(cert));
}
function generateSelfSignedCodeSigningCertificate({
	keyPair,
	validityNotBefore,
	validityNotAfter,
	commonName: value,
}) {
	const name = commonName(value);
	return issue({
		publicKey: keyPair.publicKey,
		privateKey: keyPair.privateKey,
		subject: name,
		issuer: name,
		notBefore: validityNotBefore,
		notAfter: validityNotAfter,
	});
}
const convertCertificateToCertificatePEM = (cert) =>
	pem("CERTIFICATE", cert.raw);
const convertCertificatePEMToCertificate = (value) =>
	certificateView(unpem(value, "CERTIFICATE"));
function validateSelfSignedCertificate(cert, pair) {
	if (cert.subject.hash !== cert.issuer.hash)
		throw Error("Certificate is not self-signed");
	const now = new Date();
	if (cert.validity.notBefore > now || cert.validity.notAfter < now)
		throw Error("Certificate validity expired");
	if (!cert.getExtension("keyUsage")?.digitalSignature)
		throw Error("Digital Signature not present");
	if (!cert.getExtension("extKeyUsage")?.codeSigning)
		throw Error("Code Signing not present");
	if (!cert.verify(cert)) throw Error("Certificate signature not valid");
	const certPub = keyObject(cert.publicKey).export({
		format: "der",
		type: "spki",
	});
	const pairPub = keyObject(pair.publicKey).export({
		format: "der",
		type: "spki",
	});
	const privatePub = publicObject(pair.privateKey).export({
		format: "der",
		type: "spki",
	});
	if (!certPub.equals(pairPub) || !pairPub.equals(privatePub))
		throw Error("key pair mismatch");
}
function signBufferRSASHA256AndVerify(privateKey, cert, message) {
	const bytes = buf(message);
	const signature = crypto.sign("sha256", bytes, {
		key: keyObject(privateKey),
		padding: crypto.constants.RSA_PKCS1_PADDING,
	});
	if (
		!crypto.verify(
			"sha256",
			bytes,
			{
				key: keyObject(cert.publicKey),
				padding: crypto.constants.RSA_PKCS1_PADDING,
			},
			signature,
		)
	)
		throw Error(
			"Signature generated with private key not valid for certificate",
		);
	return signature.toString("base64");
}
function csrView(model) {
	if (
		model.signatureAlgorithm.algorithm !== RSA_SHA256 ||
		(model.signatureAlgorithm.parameters !== null &&
			model.signatureAlgorithm.parameters !== undefined)
	)
		throw Error("Unsupported CSR signature algorithm");
	const publicKey = wrapKey(
		crypto.createPublicKey({
			key: der(model.certificationRequestInfo.subjectPKInfo),
			format: "der",
			type: "spki",
		}),
	);
	keyObject(publicKey);
	const result = {
		model,
		publicKey,
		subject: nameView(model.certificationRequestInfo.subject),
		signature: buf(model.signature).toString("latin1"),
		verify() {
			return crypto.verify(
				"sha256",
				der(this.model.certificationRequestInfo),
				{
					key: keyObject(this.publicKey),
					padding: crypto.constants.RSA_PKCS1_PADDING,
				},
				Buffer.from(this.signature, "latin1"),
			);
		},
	};
	return result;
}
function generateCSR(pair, value) {
	const info = new c.CertificationRequestInfo({
		subject: commonName(value),
		subjectPKInfo: spki(pair.publicKey),
		attributes: new c.Attributes(),
	});
	const signature = crypto.sign("sha256", der(info), {
		key: keyObject(pair.privateKey),
		padding: crypto.constants.RSA_PKCS1_PADDING,
	});
	return csrView(
		new c.CertificationRequest({
			certificationRequestInfo: info,
			signatureAlgorithm: algorithm(),
			signature,
		}),
	);
}
function convertCSRToCSRPEM(csr) {
	const model = new c.CertificationRequest({
		...csr.model,
		signature: Buffer.from(csr.signature, "latin1"),
	});
	return pem("CERTIFICATE REQUEST", der(model));
}
const convertCSRPEMToCSR = (value) =>
	csrView(
		strictParse(unpem(value, "CERTIFICATE REQUEST"), c.CertificationRequest),
	);
function generateDevelopmentCertificateFromCSR(
	issuerPrivateKey,
	issuerCert,
	csr,
	appId,
	scopeKey,
) {
	assert(csr.verify(), "CSR not self-signed");
	const before = new Date();
	before.setDate(before.getDate() - 1);
	const after = new Date();
	after.setDate(after.getDate() + 30);
	return issue({
		publicKey: csr.publicKey,
		privateKey: issuerPrivateKey,
		subject: csr.subject.asn,
		issuer: issuerCert.subject.asn,
		notBefore: before,
		notAfter: after,
		project: `${appId},${scopeKey}`,
	});
}
module.exports = {
	expoProjectInformationOID: EXPO_OID,
	generateKeyPair,
	convertKeyPairToPEM,
	convertKeyPairPEMToKeyPair,
	convertPublicKeyPEMToPublicKey,
	convertPrivateKeyPEMToPrivateKey,
	generateSelfSignedCodeSigningCertificate,
	convertCertificateToCertificatePEM,
	convertCertificatePEMToCertificate,
	validateSelfSignedCertificate,
	signBufferRSASHA256AndVerify,
	generateCSR,
	convertCSRToCSRPEM,
	convertCSRPEMToCSR,
	generateDevelopmentCertificateFromCSR,
};
