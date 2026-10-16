/**
 * When Nominatim refuses us, `/location-search` answers like every other limit
 * in oxy-api: 429, `Retry-After` with the wait Nominatim stated and the typed
 * `RATE_LIMITED` error (`middleware/rateLimiter.ts`). A timeout stays 408.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import locationSearchController from '../locationSearch.controller';
import locationService, {
  LocationRateLimitedError,
  LocationTimeoutError,
} from '../../services/locationService';

const app = express();
app.get('/search', locationSearchController.searchLocations);
app.get('/details', locationSearchController.getLocationDetails);

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a Nominatim refusal', () => {
  it('answers a search with RATE_LIMITED and the stated wait', async () => {
    jest
      .spyOn(locationService, 'searchLocations')
      .mockRejectedValue(new LocationRateLimitedError(30));

    const response = await request(app).get('/search').query({ query: 'Barcelona' });

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('30');
    expect(response.body).toMatchObject({
      error: 'RATE_LIMITED',
      message: 'Rate limit exceeded. Please try again in a moment.',
      details: { retryAfterSeconds: 30 },
    });
  });

  it('answers a details lookup the same way', async () => {
    jest
      .spyOn(locationService, 'getLocationDetails')
      .mockRejectedValue(new LocationRateLimitedError(4.2));

    const response = await request(app).get('/details').query({ lat: '41.38', lon: '2.17' });

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.body).toMatchObject({ error: 'RATE_LIMITED' });
  });
});

it('answers a search that timed out with 408', async () => {
  jest.spyOn(locationService, 'searchLocations').mockRejectedValue(new LocationTimeoutError());

  const response = await request(app).get('/search').query({ query: 'Barcelona' });

  expect(response.status).toBe(408);
  expect(response.body).toEqual({ message: 'Request timeout. Please try again.' });
});
