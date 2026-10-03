const Sequencer = require('/home/nate/Oxy/oxy/.worktrees/1519-final-integration-20261003/packages/api/jest.shardSequencer.cjs');
module.exports = class Ordered extends Sequencer { sort(tests) { return tests.sort((a,b) => Number(b.path.includes('foregroundCapabilities.db')) - Number(a.path.includes('foregroundCapabilities.db'))); } };
