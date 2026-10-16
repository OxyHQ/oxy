// Jest setup for API package
const dotenv = require('dotenv');
dotenv.config({ path: '.env.test' });

// The suite's environment, defined once for every run: CI and a local
// `bun run test` see the same values. They used to live only in the CI job's
// `env:`, so locally every test that mints a session failed with "Token secrets
// are not configured" and read as broken on main. Test-only values, never real
// secrets; a value already in the environment (or `.env.test`) wins.
const TEST_ENVIRONMENT = {
  ACCESS_TOKEN_SECRET: 'test_access_token_secret_minimum_32_characters',
  REFRESH_TOKEN_SECRET: 'test_refresh_token_secret_minimum_32_characters',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test_aws_access_key',
  AWS_SECRET_ACCESS_KEY: 'test_aws_secret_key',
  AWS_S3_BUCKET: 'test-bucket',
};
for (const [name, value] of Object.entries(TEST_ENVIRONMENT)) {
  process.env[name] ??= value;
}

// Mock jsonwebtoken
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'mock-jwt-token'),
  verify: jest.fn(() => ({ userId: 'test-user-id', sessionId: 'test-session-id' })),
}));

// Mock socket.io
jest.mock('socket.io', () => ({
  Server: jest.fn(() => ({
    on: jest.fn(),
    emit: jest.fn(),
    to: jest.fn(() => ({ emit: jest.fn() })),
  })),
}));

// Set test timeout
jest.setTimeout(10000);
