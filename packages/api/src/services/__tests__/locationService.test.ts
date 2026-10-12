/**
 * `locationService` talks to Nominatim through `tracedFetch` (it used axios).
 * These pin the axios behaviour the port has to keep: a non-2xx status is an
 * error even when its body parses, a 429 maps to the rate-limit message after a
 * 2s back-off, a timeout maps to the timeout message in search, and the request
 * carries the User-Agent Nominatim's usage policy requires plus a timeout signal.
 */

jest.mock('../../utils/tracedFetch', () => ({ tracedFetch: jest.fn() }));

import { tracedFetch } from '../../utils/tracedFetch';
import { nominatimRateLimiter } from '../../utils/apiRateLimiter';
import { locationService } from '../locationService';

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
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

  it('maps a 429 to the rate-limit message after backing off 2s', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'slow down' }, 429));

    const outcome = expect(
      locationService.searchLocations('rate limited query', { useCache: false }),
    ).rejects.toThrow('Rate limit exceeded. Please try again in a moment.');
    await jest.advanceTimersByTimeAsync(2000);
    await outcome;
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

  it('maps a 429 to the rate-limit message after backing off 2s', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'slow down' }, 429));

    const outcome = expect(
      locationService.getLocationDetails(3.5, 4.5, { useCache: false }),
    ).rejects.toThrow('Rate limit exceeded. Please try again in a moment.');
    await jest.advanceTimersByTimeAsync(2000);
    await outcome;
  });

  it('keeps a timeout as the generic error, as before', async () => {
    fetchMock.mockRejectedValueOnce(timeoutError());

    await expect(locationService.getLocationDetails(5.5, 6.5, { useCache: false })).rejects.toThrow(
      'Error getting location details',
    );
  });
});
