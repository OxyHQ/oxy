// Jest setup for API package
const dotenv = require('dotenv');
dotenv.config({ path: '.env.test' });

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
