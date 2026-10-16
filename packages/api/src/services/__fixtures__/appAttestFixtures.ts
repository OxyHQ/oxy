/**
 * A test App Attest world (ADR 0045): a root CA standing in for Apple's, an
 * intermediate, and devices that attest keys and sign assertions exactly as
 * Apple's App Attest service and `@expo/app-integrity` do — so the verifier is
 * exercised on real certificates, CBOR and signatures, with only the trust
 * anchor swapped.
 */

import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign,
  X509Certificate,
} from 'node:crypto';
import { encodeCBOR } from '@levischuck/tiny-cbor';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import {
  AlgorithmIdentifier,
  AttributeTypeAndValue,
  AttributeValue,
  BasicConstraints,
  Certificate,
  Extension,
  Extensions,
  id_ce_basicConstraints,
  Name,
  RelativeDistinguishedName,
  SubjectPublicKeyInfo,
  TBSCertificate,
  Validity,
  Version,
} from '@peculiar/asn1-x509';
import * as asn1js from 'asn1js';
import { APP_ATTEST_NONCE_EXTENSION_OID } from '../appAttest';

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const DAY = 24 * 60 * 60 * 1000;

const sha256 = (...parts: Uint8Array[]): Buffer => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const arrayBuffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;

function name(commonName: string): Name {
  return new Name([
    new RelativeDistinguishedName([
      new AttributeTypeAndValue({
        type: '2.5.4.3',
        value: new AttributeValue({ utf8String: commonName }),
      }),
    ]),
  ]);
}

let serial = 1;

function certificate(input: {
  subject: string;
  issuer: string;
  subjectKey: KeyObject;
  issuerKey: KeyObject;
  ca: boolean;
  extensions?: Extension[];
  notBefore: Date;
  notAfter: Date;
}): Buffer {
  const extensions = [...(input.extensions ?? [])];
  if (input.ca) {
    extensions.push(
      new Extension({
        extnID: id_ce_basicConstraints,
        critical: true,
        extnValue: new OctetString(AsnConvert.serialize(new BasicConstraints({ cA: true }))),
      }),
    );
  }
  const tbs = new TBSCertificate({
    version: Version.v3,
    serialNumber: arrayBuffer(new Uint8Array([serial++])),
    signature: new AlgorithmIdentifier({ algorithm: ECDSA_WITH_SHA256 }),
    issuer: name(input.issuer),
    validity: new Validity({ notBefore: input.notBefore, notAfter: input.notAfter }),
    subject: name(input.subject),
    subjectPublicKeyInfo: AsnConvert.parse(
      input.subjectKey.export({ type: 'spki', format: 'der' }),
      SubjectPublicKeyInfo,
    ),
    ...(extensions.length > 0 ? { extensions: new Extensions(extensions) } : {}),
  });
  const signature = sign('sha256', Buffer.from(AsnConvert.serialize(tbs)), input.issuerKey);
  return Buffer.from(
    AsnConvert.serialize(
      new Certificate({
        tbsCertificate: tbs,
        signatureAlgorithm: new AlgorithmIdentifier({ algorithm: ECDSA_WITH_SHA256 }),
        signatureValue: arrayBuffer(signature),
      }),
    ),
  );
}

/** Apple's nonce extension: `SEQUENCE { [1] EXPLICIT OCTET STRING nonce }`. */
function nonceExtension(nonce: Buffer): Extension {
  const value = new asn1js.Sequence({
    value: [
      new asn1js.Constructed({
        idBlock: { tagClass: 3, tagNumber: 1 },
        value: [new asn1js.OctetString({ valueHex: arrayBuffer(nonce) })],
      }),
    ],
  }).toBER();
  return new Extension({
    extnID: APP_ATTEST_NONCE_EXTENSION_OID,
    critical: false,
    extnValue: new OctetString(value),
  });
}

function uncompressedPoint(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x as string, 'base64url'),
    Buffer.from(jwk.y as string, 'base64url'),
  ]);
}

const AAGUID = {
  production: Buffer.concat([Buffer.from('appattest', 'ascii'), Buffer.alloc(7)]),
  development: Buffer.from('appattestdevelop', 'ascii'),
};

export interface AttestOptions {
  /** The app id the device attests for; defaults to the device's. */
  readonly appId?: string;
  readonly environment?: keyof typeof AAGUID;
  readonly counter?: number;
  /** Put a different nonce in the certificate. */
  readonly nonce?: Buffer;
  /** Name a different credential id in the authenticator data. */
  readonly credentialId?: Buffer;
  /** Sign the credential certificate with a CA outside the chain. */
  readonly rogueIntermediate?: boolean;
}

export interface TestAppAttestDevice {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  /** The attestation object for `clientData` (a challenge's `requestHash`), base64. */
  attest(clientData: string, options?: AttestOptions): string;
  /** An assertion over `clientData` with this counter, base64. */
  assert(clientData: string, counter: number, options?: { appId?: string; key?: KeyObject }): string;
}

export interface TestAppAttestWorld {
  /** The trust anchor that replaces Apple's root. */
  readonly root: X509Certificate;
  device(appId: string): TestAppAttestDevice;
}

/** A root, an intermediate under it, and a factory for attesting devices. */
export function createTestAppAttestWorld(now: Date = new Date()): TestAppAttestWorld {
  const notBefore = new Date(now.getTime() - DAY);
  const notAfter = new Date(now.getTime() + 365 * DAY);
  const rootKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const intermediateKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rogueKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const root = certificate({
    subject: 'Test App Attestation Root CA',
    issuer: 'Test App Attestation Root CA',
    subjectKey: rootKey.publicKey,
    issuerKey: rootKey.privateKey,
    ca: true,
    notBefore,
    notAfter,
  });
  const intermediateFor = (signer: KeyObject) =>
    certificate({
      subject: 'Test App Attestation CA 1',
      issuer: 'Test App Attestation Root CA',
      subjectKey: intermediateKey.publicKey,
      issuerKey: signer,
      ca: true,
      notBefore,
      notAfter,
    });
  const intermediate = intermediateFor(rootKey.privateKey);
  const rogueIntermediate = intermediateFor(rogueKey.privateKey);

  return {
    root: new X509Certificate(root),
    device(appId) {
      const key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const keyIdHash = sha256(uncompressedPoint(key.publicKey));
      const rpIdHash = (id: string) => sha256(Buffer.from(id, 'utf8'));
      return {
        keyId: keyIdHash.toString('base64'),
        publicKey: key.publicKey,
        attest(clientData, options = {}) {
          const counter = Buffer.alloc(4);
          counter.writeUInt32BE(options.counter ?? 0);
          const credentialId = options.credentialId ?? keyIdHash;
          const idLength = Buffer.alloc(2);
          idLength.writeUInt16BE(credentialId.length);
          const authData = Buffer.concat([
            rpIdHash(options.appId ?? appId),
            Buffer.from([0x40]),
            counter,
            AAGUID[options.environment ?? 'production'],
            idLength,
            credentialId,
            Buffer.from(encodeCBOR(new Map<number, number>([[1, 2]]))),
          ]);
          const clientDataHash = sha256(Buffer.from(clientData, 'utf8'));
          const credential = certificate({
            subject: keyIdHash.toString('hex'),
            issuer: 'Test App Attestation CA 1',
            subjectKey: key.publicKey,
            issuerKey: options.rogueIntermediate ? rogueKey.privateKey : intermediateKey.privateKey,
            ca: false,
            extensions: [nonceExtension(options.nonce ?? sha256(authData, clientDataHash))],
            notBefore,
            notAfter,
          });
          const chain = [
            new Uint8Array(credential),
            new Uint8Array(options.rogueIntermediate ? rogueIntermediate : intermediate),
          ];
          return Buffer.from(
            encodeCBOR(
              new Map<string, unknown>([
                ['fmt', 'apple-appattest'],
                [
                  'attStmt',
                  new Map<string, unknown>([
                    ['x5c', chain],
                    ['receipt', new Uint8Array(0)],
                  ]),
                ],
                ['authData', new Uint8Array(authData)],
              ]) as never,
            ),
          ).toString('base64');
        },
        assert(clientData, counterValue, options = {}) {
          const counter = Buffer.alloc(4);
          counter.writeUInt32BE(counterValue);
          const authenticatorData = Buffer.concat([
            rpIdHash(options.appId ?? appId),
            Buffer.from([0x00]),
            counter,
          ]);
          const nonce = sha256(authenticatorData, sha256(Buffer.from(clientData, 'utf8')));
          const signature = sign('sha256', nonce, options.key ?? key.privateKey);
          return Buffer.from(
            encodeCBOR(
              new Map<string, Uint8Array>([
                ['signature', new Uint8Array(signature)],
                ['authenticatorData', new Uint8Array(authenticatorData)],
              ]),
            ),
          ).toString('base64');
        },
      };
    },
  };
}
