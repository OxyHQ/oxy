import type { KeyObject } from "node:crypto";

export interface PublicInteger {
	equals(other: PublicInteger): boolean;
	bitLength(): number;
	toString(radix?: number): string;
}
export interface NativeKey {
	readonly keyObject: KeyObject;
}
export interface PublicKey extends NativeKey {
	readonly n: PublicInteger;
	readonly e: PublicInteger;
}
export interface PrivateKey extends PublicKey {
	readonly d: PublicInteger;
}
export interface KeyPair {
	publicKey: PublicKey;
	privateKey: PrivateKey;
}
export interface DistinguishedName {
	readonly hash: string;
	readonly attributes: ReadonlyArray<{
		type: string;
		name?: string;
		value: string;
	}>;
	getField(
		field: string | { name: string },
	): { type: string; name?: string; value: string } | undefined;
}
export interface Extension {
	id: string;
	name?: string;
	critical: boolean;
	digitalSignature?: boolean;
	codeSigning?: boolean;
	value?: string;
}
export interface Certificate {
	readonly raw: Buffer;
	readonly publicKey: NativeKey;
	readonly subject: DistinguishedName;
	readonly issuer: DistinguishedName;
	readonly validity: { notBefore: Date; notAfter: Date };
	getExtension(field: string | { id: string }): Extension | null;
	verify(other: Certificate): boolean;
}
export interface CertificateRequest {
	readonly publicKey: PublicKey;
	readonly subject: DistinguishedName;
	signature: string;
	verify(): boolean;
}
export const expoProjectInformationOID: string;
export function generateKeyPair(): KeyPair;
export function convertKeyPairToPEM(pair: KeyPair): {
	privateKeyPEM: string;
	publicKeyPEM: string;
};
export function convertKeyPairPEMToKeyPair(pair: {
	privateKeyPEM: string;
	publicKeyPEM: string;
}): KeyPair;
export function convertPublicKeyPEMToPublicKey(pem: string): PublicKey;
export function convertPrivateKeyPEMToPrivateKey(pem: string): PrivateKey;
export function generateSelfSignedCodeSigningCertificate(options: {
	keyPair: KeyPair;
	validityNotBefore: Date;
	validityNotAfter: Date;
	commonName: string;
}): Certificate;
export function convertCertificateToCertificatePEM(
	certificate: Certificate,
): string;
export function convertCertificatePEMToCertificate(pem: string): Certificate;
export function validateSelfSignedCertificate(
	certificate: Certificate,
	pair: KeyPair,
): void;
export function signBufferRSASHA256AndVerify(
	key: PrivateKey,
	certificate: Certificate,
	message: Buffer,
): string;
export function generateCSR(
	pair: KeyPair,
	commonName: string,
): CertificateRequest;
export function convertCSRToCSRPEM(request: CertificateRequest): string;
export function convertCSRPEMToCSR(pem: string): CertificateRequest;
export function generateDevelopmentCertificateFromCSR(
	issuerPrivateKey: PrivateKey,
	issuerCertificate: Certificate,
	request: CertificateRequest,
	appId: string,
	scopeKey: string,
): Certificate;
