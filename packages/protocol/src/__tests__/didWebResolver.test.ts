/**
 * `createDidWebResolver` tests — `did:web` → `did.json` URL mapping, and the
 * resolution of a fetched DID document to its current verification keys, driven
 * by a STUB `NodeFetch` (no network). Locks the multi-subject authorization
 * input the chain engine consults on relay/ingest paths.
 */

import type { DidDocument } from '@oxy.so/contracts';
import { createDidWebResolver, didWebToUrl } from '../node/didWebResolver';
import type { NodeFetch, NodeFetchResponse } from '../node/httpFetch';

const SUBJECT = 'did:web:node.example:u:owner';
const KEY_A = `04${'a'.repeat(128)}`;
const KEY_B = `04${'b'.repeat(128)}`;

function didDoc(overrides: Partial<DidDocument> = {}): DidDocument {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: SUBJECT,
    controller: [SUBJECT],
    verificationMethod: [
      { id: `${SUBJECT}#key-1`, type: 'EcdsaSecp256k1VerificationKey2019', controller: SUBJECT, publicKeyHex: KEY_A },
    ],
    authentication: [`${SUBJECT}#key-1`],
    assertionMethod: [`${SUBJECT}#key-1`],
    alsoKnownAs: [],
    service: [],
    ...overrides,
  };
}

function jsonResponse(obj: unknown, status = 200): NodeFetchResponse {
  return {
    status,
    headers: {},
    body: (async function* () {
      yield Buffer.from(JSON.stringify(obj));
    })(),
    destroy() {},
  };
}

describe('didWebToUrl', () => {
  it('maps an apex did:web to its well-known did.json', () => {
    expect(didWebToUrl('did:web:example.com')).toBe('https://example.com/.well-known/did.json');
  });

  it('maps a pathed did:web to a path did.json', () => {
    expect(didWebToUrl('did:web:example.com:u:123')).toBe('https://example.com/u/123/did.json');
  });

  it('decodes a %3A port in the host segment', () => {
    expect(didWebToUrl('did:web:localhost%3A3000')).toBe('https://localhost:3000/.well-known/did.json');
  });

  it('returns null for a non-did:web identifier', () => {
    expect(didWebToUrl('did:key:z6Mk')).toBeNull();
    expect(didWebToUrl('not-a-did')).toBeNull();
  });
});

describe('createDidWebResolver', () => {
  it('resolves a subject to the verification keys in its DID document', async () => {
    const calls: string[] = [];
    const fetch: NodeFetch = async (url) => {
      calls.push(url);
      return jsonResponse(didDoc());
    };
    const resolver = createDidWebResolver(fetch);
    const resolved = await resolver.resolve(SUBJECT);
    expect(resolved).toEqual({ currentPublicKeys: [KEY_A] });
    expect(calls).toEqual(['https://node.example/u/owner/did.json']);
  });

  it('collects every assertionMethod key (deduped)', async () => {
    const doc = didDoc({
      verificationMethod: [
        { id: `${SUBJECT}#key-1`, type: 'EcdsaSecp256k1VerificationKey2019', controller: SUBJECT, publicKeyHex: KEY_A },
        { id: `${SUBJECT}#key-2`, type: 'EcdsaSecp256k1VerificationKey2019', controller: SUBJECT, publicKeyHex: KEY_B },
      ],
      assertionMethod: [`${SUBJECT}#key-1`, `${SUBJECT}#key-2`],
    });
    const resolver = createDidWebResolver(async () => jsonResponse(doc));
    expect(await resolver.resolve(SUBJECT)).toEqual({ currentPublicKeys: [KEY_A, KEY_B] });
  });

  it('ignores a Multikey VM and collects only the secp256k1 hex keys', async () => {
    // An atproto-bridged document carries an extra `Multikey` VM (the SAME key in
    // multibase form, no `publicKeyHex`). The resolver must skip it and resolve to
    // the hex signing key only.
    const doc = didDoc({
      verificationMethod: [
        { id: `${SUBJECT}#key-1`, type: 'EcdsaSecp256k1VerificationKey2019', controller: SUBJECT, publicKeyHex: KEY_A },
        { id: `${SUBJECT}#atproto`, type: 'Multikey', controller: SUBJECT, publicKeyMultibase: 'zQ3shFakeMultibaseKey' },
      ],
      authentication: [`${SUBJECT}#key-1`, `${SUBJECT}#atproto`],
      assertionMethod: [`${SUBJECT}#key-1`, `${SUBJECT}#atproto`],
    });
    const resolver = createDidWebResolver(async () => jsonResponse(doc));
    expect(await resolver.resolve(SUBJECT)).toEqual({ currentPublicKeys: [KEY_A] });
  });

  it('returns null for a non-did:web subject (no fetch)', async () => {
    const fetch = jest.fn();
    const resolver = createDidWebResolver(fetch as unknown as NodeFetch);
    expect(await resolver.resolve('did:key:z6Mk')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns null on a non-2xx did.json fetch', async () => {
    const resolver = createDidWebResolver(async () => jsonResponse({ error: 'nope' }, 404));
    expect(await resolver.resolve(SUBJECT)).toBeNull();
  });

  it('returns null when the document id does not match the subject', async () => {
    const resolver = createDidWebResolver(async () => jsonResponse(didDoc({ id: 'did:web:other.example' })));
    expect(await resolver.resolve(SUBJECT)).toBeNull();
  });

  it('returns null and reports onError when the fetch throws', async () => {
    const onError = jest.fn();
    const boom = new Error('ECONNREFUSED');
    const resolver = createDidWebResolver(
      async () => {
        throw boom;
      },
      { onError },
    );
    expect(await resolver.resolve(SUBJECT)).toBeNull();
    expect(onError).toHaveBeenCalledWith(boom, SUBJECT);
  });
});
