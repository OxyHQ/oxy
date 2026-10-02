#!/usr/bin/env node
// Synthetic known-key malformed signatures: not a demonstration of no-key forgery.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(process.argv[2] || '');
const mode = process.argv[3];
assert(['stock', 'candidate'].includes(mode), 'Usage: node script PACKAGE_PATH stock|candidate');
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version, '1.4.0');
const {privateKey, publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
const pem = publicKey.export({type: 'spki', format: 'pem'}).toString();
const message = Buffer.from('Oxy synthetic Forge candidate regression; no customer data');
const source = require(root);
function tlv(tag, bytes) {
  bytes = Buffer.from(bytes);
  assert(bytes.length < 128);
  return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
}
function digestInfo(algorithm, variant) {
  const digest = crypto.createHash(algorithm).update(message).digest();
  const oid = Buffer.from(source.asn1.oidToDer(source.oids[algorithm]).getBytes(), 'binary');
  let params = variant === 'absent-null' ? Buffer.alloc(0) : tlv(5, variant === 'nonempty-null' ? [0] : []);
  let nested = Buffer.concat([tlv(6, oid), params]);
  if(variant === 'extra-nested') nested = Buffer.concat([nested, tlv(5, [])]);
  if(variant === 'wrong-digest') digest[0] ^= 1;
  let outer = Buffer.concat([tlv(48, nested), tlv(4, digest)]);
  if(variant === 'extra-outer') outer = Buffer.concat([outer, tlv(5, [])]);
  let der = tlv(48, outer);
  if(variant === 'trailing') der = Buffer.concat([der, tlv(5, [])]);
  return {der, digest: crypto.createHash(algorithm).update(message).digest()};
}
// Use the supported signing API and normal PKCS#1 v1.5 padding with our own key.
const fixtureSigner = source.pki.privateKeyFromPem(privateKey.export({type: 'pkcs1', format: 'pem'}).toString());
function signEncoded(der) {
  return Buffer.from(fixtureSigner.sign(der.toString('binary'), 'NONE'), 'binary');
}
function accepted(forge, digest, signature) {
  try { return forge.pki.publicKeyFromPem(pem).verify(digest.toString('binary'), signature.toString('binary')); }
  catch { return false; }
}
const distributions = [['lib', source]];
for(const filename of ['forge.min.js', 'forge.all.min.js']) {
  const sandbox = {console, setTimeout, clearTimeout, Uint8Array, ArrayBuffer, jQuery: Object.assign(function() { return {ready() {}, mousemove() {}, keypress() {}}; }, {fn: {}})};
  sandbox.window = sandbox; sandbox.self = sandbox;
  try { vm.runInNewContext(fs.readFileSync(path.join(root, 'dist', filename), 'utf8'), sandbox, {filename}); } catch (e) { throw new Error(filename + ': ' + e.message); }
  assert(sandbox.forge, filename + ' must load browser global');
  distributions.push([filename, sandbox.forge]);
}
const rows = [];
for(const algorithm of ['sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha512-224', 'sha512-256', 'md5']) {
  for(const variant of ['empty-null', 'absent-null', 'extra-nested', 'nonempty-null', 'extra-outer', 'trailing', 'wrong-digest']) {
    const {der, digest} = digestInfo(algorithm, variant);
    const signature = signEncoded(der);
    const nodeAccepted = crypto.verify(algorithm, message, publicKey, signature);
    const valid = ['empty-null', 'absent-null'].includes(variant);
    // Forge permits optional NULL; OpenSSL may require it for specific algorithms.
    if(variant === 'empty-null') assert(nodeAccepted, algorithm + ': Node valid control');
    if(!valid) assert(!nodeAccepted, algorithm + '/' + variant + ': Node rejects malformed control');
    for(const [distribution, forge] of distributions) {
      const actual = accepted(forge, digest, signature);
      const forgeValid = variant === 'empty-null' || (variant === 'absent-null' && algorithm !== 'md5');
      const expected = forgeValid || (mode === 'stock' && ['extra-nested', 'nonempty-null'].includes(variant));
      assert.equal(actual, expected, algorithm + '/' + variant + '/' + distribution);
      rows.push({algorithm, variant, distribution, forgeAccepted: actual, nodeAccepted});
    }
  }
}
console.log(JSON.stringify({mode, node: process.version, openssl: process.versions.openssl,
  packageVersion: '1.4.0', knownKeyControlsOnly: true, count: rows.length, rows}, null, 2));
