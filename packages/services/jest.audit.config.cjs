const config = require('./jest.config.js');
config.moduleNameMapper = {
  '^@oxy.so/core/session$': '<rootDir>/../core/src/session/index.ts',
  ...config.moduleNameMapper,
};
module.exports = config;
