import crypto from "node:crypto";

/** Canonical application credential material; plaintext is returned once. */
export function generateCredentialMaterial(): {
	publicKey: string;
	secret: string;
	secretHash: string;
} {
	const publicKey = `oxy_dk_${crypto.randomBytes(24).toString("hex")}`;
	const secret = crypto.randomBytes(32).toString("hex");
	const secretHash = crypto.createHash("sha256").update(secret).digest("hex");
	return { publicKey, secret, secretHash };
}

export type CredentialVerifier = { publicKey: string; secretHash: string };
/** Never serialize the plaintext secret into a remote task definition. */
export function credentialVerifier(
	material: ReturnType<typeof generateCredentialMaterial>,
): CredentialVerifier {
	if (
		crypto.createHash("sha256").update(material.secret).digest("hex") !==
		material.secretHash
	) {
		throw new Error("credential_material_mismatch");
	}
	return { publicKey: material.publicKey, secretHash: material.secretHash };
}
