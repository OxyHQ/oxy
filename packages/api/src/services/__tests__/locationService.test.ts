/**
 * `locationService` talks to Nominatim through `tracedFetch` (it used axios).
 * These pin the axios behaviour the port has to keep: a non-2xx status is an
 * error even when its body parses, a timeout maps to the timeout message in
 * search, and the request carries the User-Agent Nominatim's usage policy
 * requires plus a timeout signal. A 429 is `LocationRateLimitedError` carrying
 * Nominatim's own `Retry-After`, and no lookup calls Nominatim again until that
 * wait has passed.
 */

jest.mock('../../utils/tracedFetch', () => ({ tracedFetch: jest.fn() }));

import { tracedFetch } from '../../utils/tracedFetch';
import { nominatimRateLimiter } from '../../utils/apiRateLimiter';
import { LocationRateLimitedError, locationService } from '../locationService';

const fetchMock = tracedFetch as jest.MockedFunction<typeof tracedFetch>;

const place = {
  place_id: 101,
  osm_id: 202,
  osm_type: 'node',
  lat: '41.3874',
  lon: '2.1686',
  display_name: 'Plaça de Catalunya, Barcelona, Spain',
  type: 'square',
  class: 'place',
  address: { city: 'Barcelona', country: 'Spain', country_code: 'es' },
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function timeoutError(): Error {
  return new DOMException('The operation timed out.', 'TimeoutError');
}

beforeEach(() => {
  fetchMock.mockReset();
  nominatimRateLimiter.clearAll();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('locationService.searchLocations', () => {
  it('parses the JSON body and sends the User-Agent and a timeout signal', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([place]));

    const results = await locationService.searchLocations('Plaça de Catalunya', {
      useCache: false,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: '101',
      name: 'Plaça de Catalunya',
      coordinates: { lat: 41.3874, lon: 2.1686 },
      metadata: { osmId: '202', countryCode: 'ES' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/nominatim\.openstreetmap\.org\/search\?/);
    expect(init?.headers).toEqual({ 'User-Agent': 'OxyHQ-LocationSearch/1.0' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('treats a non-2xx status as an error even when its body parses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([place], 500));

    await expect(
      locationService.searchLocations('server error query', { useCache: false }),
    ).rejects.toThrow('Error searching locations');
  });

  it("maps a 429 to LocationRateLimitedError carrying Nominatim's Retry-After", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'slow down' }, 429, { 'Retry-After': '30' }),
    );

    const error = await locationService
      .searchLocations('rate limited query', { useCache: false })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LocationRateLimitedError);
    expect((error as LocationRateLimitedError).retryAfterSeconds).toBe(30);
    expect((error as Error).message).toBe('Rate limit exceeded. Please try again in a moment.');
  });

  it('waits a default when the 429 states no Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'slow down' }, 429));

    const error = await locationService
      .searchLocations('rate limited, no header', { useCache: false })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LocationRateLimitedError);
    expect((error as LocationRateLimitedError).retryAfterSeconds).toBe(5);
  });

  it('calls Nominatim for no lookup until its stated wait has passed', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'slow down' }, 429, { 'Retry-After': '10' }),
    );
    await expect(
      locationService.searchLocations('first query', { useCache: false }),
    ).rejects.toBeInstanceOf(LocationRateLimitedError);

    await jest.advanceTimersByTimeAsync(4_000);
    const refused = await locationService
      .getLocationDetails(7.5, 8.5, { useCache: false })
      .catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(LocationRateLimitedError);
    expect((refused as LocationRateLimitedError).retryAfterSeconds).toBe(6);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(6_000);
    fetchMock.mockResolvedValueOnce(jsonResponse([place]));
    await expect(
      locationService.searchLocations('after the wait', { useCache: false }),
    ).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps a timeout to the timeout message', async () => {
    fetchMock.mockRejectedValueOnce(timeoutError());

    await expect(
      locationService.searchLocations('timed out query', { useCache: false }),
    ).rejects.toThrow('Request timeout. Please try again.');
  });

  it('maps a body that is not JSON to the generic error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>busy</html>', { status: 200 }));

    await expect(
      locationService.searchLocations('html body query', { useCache: false }),
    ).rejects.toThrow('Error searching locations');
  });
});

describe('locationService.getLocationDetails', () => {
  it('parses the JSON body of a reverse lookup', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(place));

    const result = await locationService.getLocationDetails(41.3874, 2.1686, { useCache: false });

    expect(result).toMatchObject({ id: '101', name: 'Plaça de Catalunya' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/nominatim\.openstreetmap\.org\/reverse\?/);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('treats a non-2xx status as an error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(place, 503));

    await expect(locationService.getLocationDetails(1.5, 2.5, { useCache: false })).rejects.toThrow(
      'Error getting location details',
    );
  });

  it("maps a 429 to LocationRateLimitedError carrying Nominatim's Retry-After", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'slow down' }, 429, { 'Retry-After': '12' }),
    );

    const error = await locationService
      .getLocationDetails(3.5, 4.5, { useCache: false })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LocationRateLimitedError);
    expect((error as LocationRateLimitedError).retryAfterSeconds).toBe(12);
  });

  it('keeps a timeout as the generic error, as before', async () => {
    fetchMock.mockRejectedValueOnce(timeoutError());

    await expect(locationService.getLocationDetails(5.5, 6.5, { useCache: false })).rejects.toThrow(
      'Error getting location details',
    );
  });
});
