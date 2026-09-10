import axios from 'axios';
import { normalizeInlineText } from '@oxy.so/core';
import { logger } from '../utils/logger';
import locationCache from '../utils/locationCache';
import { nominatimRateLimiter } from '../utils/apiRateLimiter';
import performanceMonitor from '../utils/performanceMonitor';
import type {
  NominatimResult,
  EnhancedLocationResult,
  LocationSearchOptions,
} from '../types/location.types';

/**
 * Normalize an OPTIONAL Nominatim text field. An absent field stays absent —
 * normalizing it into an empty string would turn "OSM has no city for this
 * place" into "this place's city is blank".
 */
function normalizeOptionalInlineText(value: string | undefined): string | undefined {
  return typeof value === 'string' ? normalizeInlineText(value) : undefined;
}

class LocationService {
  private readonly baseUrl = 'https://nominatim.openstreetmap.org';
  private readonly defaultHeaders = {
    'User-Agent': 'OxyHQ-LocationSearch/1.0'
  };

  /**
   * Optimize search query for better results
   */
  private optimizeQuery(query: string): string {
    // Remove extra whitespace and normalize
    let optimized = normalizeInlineText(query);
    
    // Add common location keywords if not present
    const locationKeywords = ['street', 'avenue', 'road', 'boulevard', 'plaza', 'square'];
    const hasLocationKeyword = locationKeywords.some(keyword => 
      optimized.toLowerCase().includes(keyword)
    );
    
    if (!hasLocationKeyword && optimized.length < 10) {
      // For short queries, try to make them more specific
      optimized = `${optimized} location`;
    }
    
    return optimized;
  }

  /**
   * Search for locations with caching and rate limiting
   */
  async searchLocations(
    query: string, 
    options: LocationSearchOptions = {}
  ): Promise<EnhancedLocationResult[]> {
    const endTimer = performanceMonitor.startTimer('location_search');
    
    const {
      limit = 5,
      countrycodes,
      addressdetails = 1,
      useCache = true,
      cacheTTL
    } = options;

    const optimizedQuery = this.optimizeQuery(query);
    
    // Check cache first
    if (useCache) {
      const cached = locationCache.get(optimizedQuery, limit, countrycodes);
      if (cached) {
        logger.info(`Cache hit for location search: ${optimizedQuery}`);
        endTimer();
        return cached;
      }
    }

    // Rate limiting
    const rateLimitKey = `nominatim:search:${optimizedQuery}`;
    await nominatimRateLimiter.waitForReset(rateLimitKey);

    try {
      logger.info(`Searching locations for query: ${optimizedQuery}`);

      // Build API URL with optimized parameters
      const params = new URLSearchParams({
        q: optimizedQuery,
        format: 'json',
        limit: limit.toString(),
        addressdetails: addressdetails.toString(),
        'accept-language': 'en',
        'dedupe': '1', // Remove duplicates
        'extratags': '1', // Get extra tags for better results
        'namedetails': '1' // Get name details
      });

      if (countrycodes) {
        params.append('countrycodes', countrycodes);
      }

      const response = await axios.get(
        `${this.baseUrl}/search?${params.toString()}`,
        {
          headers: this.defaultHeaders,
          timeout: 8000 // Reduced timeout for faster response
        }
      );

      const results: NominatimResult[] = response.data;

      // Transform and enhance results
      const enhancedResults = this.transformResults(results);

      // Cache the results
      if (useCache) {
        locationCache.set(optimizedQuery, limit, enhancedResults, countrycodes, cacheTTL);
      }

      logger.info(`Found ${enhancedResults.length} locations for query: ${optimizedQuery}`);
      endTimer();
      return enhancedResults;

    } catch (error) {
      logger.error('Error searching locations:', error);
      endTimer();
      
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          // Rate limited - increase wait time
          await new Promise(resolve => setTimeout(resolve, 2000));
          throw new Error('Rate limit exceeded. Please try again in a moment.');
        }
        if (error.code === 'ECONNABORTED') {
          throw new Error('Request timeout. Please try again.');
        }
      }

      throw new Error('Error searching locations');
    }
  }

  /**
   * Get location details by coordinates with caching
   */
  async getLocationDetails(
    lat: number, 
    lon: number, 
    options: { useCache?: boolean; cacheTTL?: number } = {}
  ): Promise<EnhancedLocationResult> {
    const { useCache = true, cacheTTL } = options;
    const cacheKey = `details:${lat.toFixed(6)}:${lon.toFixed(6)}`;

    // Check cache first
    if (useCache) {
      const cached = locationCache.get(cacheKey, 1);
      if (cached && cached.length > 0) {
        logger.info(`Cache hit for location details: ${lat}, ${lon}`);
        return cached[0];
      }
    }

    // Rate limiting
    const rateLimitKey = `nominatim:details:${lat}:${lon}`;
    await nominatimRateLimiter.waitForReset(rateLimitKey);

    try {
      logger.info(`Getting location details for coordinates: ${lat}, ${lon}`);

      const response = await axios.get(
        `${this.baseUrl}/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1&accept-language=en&extratags=1&namedetails=1`,
        {
          headers: this.defaultHeaders,
          timeout: 8000
        }
      );

      const result: NominatimResult = response.data;
      const enhancedResult = this.transformResults([result])[0];

      // Cache the result
      if (useCache) {
        locationCache.set(cacheKey, 1, [enhancedResult], undefined, cacheTTL);
      }

      logger.info(`Retrieved location details for: ${result.display_name}`);
      return enhancedResult;

    } catch (error) {
      logger.error('Error getting location details:', error);
      
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          throw new Error('Rate limit exceeded. Please try again in a moment.');
        }
      }

      throw new Error('Error getting location details');
    }
  }

  /**
   * Transform Nominatim results to our enhanced format.
   *
   * Every text field here is THIRD-PARTY: it is whatever OpenStreetMap
   * contributors typed, relayed by Nominatim, and it lands on a user profile
   * (`locations[].name` / `.address.formattedAddress`) that clients render in an
   * RN `Text` (`white-space: pre-wrap`) — so a stray newline or a double space in
   * an OSM name would be shown verbatim. Each one is a single-line display value,
   * so all of them go through the canonical inline normalizer at ingest.
   */
  private transformResults(results: NominatimResult[]): EnhancedLocationResult[] {
    return results.map(result => {
      const address = result.address || {};
      const lat = Number.parseFloat(result.lat) || 0;
      const lon = Number.parseFloat(result.lon) || 0;

      const displayName = normalizeInlineText(result.display_name);
      // Extract name from display_name (first part before comma)
      const name = normalizeInlineText(displayName.split(',')[0]) || displayName;

      return {
        id: result.place_id.toString(),
        name,
        displayName,
        type: result.type || result.class || 'unknown',
        coordinates: {
          lat,
          lon,
        },
        address: {
          street: normalizeOptionalInlineText(address.road),
          city: normalizeOptionalInlineText(address.city || address.suburb),
          state: normalizeOptionalInlineText(address.state),
          postalCode: normalizeOptionalInlineText(address.postcode),
          country: normalizeOptionalInlineText(address.country),
          formattedAddress: displayName,
        },
        metadata: {
          placeId: result.place_id.toString(),
          osmId: result.osm_id.toString(),
          osmType: result.osm_type,
          countryCode: address.country_code?.toUpperCase(),
        },
      };
    });
  }

  /**
   * Batch search multiple queries efficiently
   */
  async batchSearch(
    queries: string[], 
    options: LocationSearchOptions = {}
  ): Promise<Map<string, EnhancedLocationResult[]>> {
    const results = new Map<string, EnhancedLocationResult[]>();
    
    // Process queries in parallel with rate limiting
    const promises = queries.map(async (query, index) => {
      // Stagger requests to avoid overwhelming the API
      if (index > 0) {
        await new Promise(resolve => setTimeout(resolve, index * 100));
      }
      
      try {
        const queryResults = await this.searchLocations(query, options);
        results.set(query, queryResults);
      } catch (error) {
        logger.error(`Error in batch search for query "${query}":`, error);
        results.set(query, []);
      }
    });

    await Promise.all(promises);
    return results;
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return locationCache.getStats();
  }

  /**
   * Clear cache
   */
  clearCache() {
    locationCache.clear();
  }
}

// Export singleton instance
export const locationService = new LocationService();
export default locationService; 