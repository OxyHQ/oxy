/**
 * Stands in for every binary asset Jest is asked to parse as JavaScript.
 *
 * Metro treats a font or an image as an asset and hands the bundle a module id;
 * Jest has no such step, so `require`-ing one reaches the raw bytes and dies on
 * the first byte (`wOF2` for a woff2, which is what Bloom's own font family
 * ships). `@oxy.so/bloom/button` pulls Bloom's fonts in transitively, so this
 * appeared the moment the app started importing Bloom's Button directly.
 *
 * A string is the right stand-in: an asset's value is an opaque handle, and no
 * test asserts on one.
 */
module.exports = 'asset-stub';
