'use strict';
const { check } = require('./checks.cjs');

const fromCore = require('node:module').createRequire(require.resolve('@oxy.so/core/package.json'));
if (fromCore('@oxy.so/contracts/package.json').version !== '4.7.0') throw new Error('core resolves another contracts version');
check(require('@oxy.so/contracts'), require('@oxy.so/core/inference'), `cjs/${typeof Bun === 'undefined' ? 'node' : 'bun'}`)
  .then(() => console.log('decisions release smoke (cjs) passed'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
