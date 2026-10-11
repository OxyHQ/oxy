/**
 * Location Service Types
 *
 * Centralized type definitions for location-related operations.
 */

export interface NominatimResult {
  place_id: number;
  licence: string;
  powered_by?: string;
  osm_type: string;
  osm_id: number;
  boundingbox: string[];
  lat: string;
  lon: string;
  display_name: string;
  place_rank?: number;
  category?: string;
  class?: string;
  type: string;
  importance: number;
  icon?: string;
  address?: {
    house_number?: string;
    road?: string;
    neighbourhood?: string;
    suburb?: string;
    city?: string;
    county?: string;
    state?: string;
    postcode?: string;
    country?: string;
    country_code?: string;
  };
}

export interface EnhancedLocationResult {
  id?: string;
  name: string;
  displayName: string;
  type: string;
  coordinates: {
    lat: number;
    lon: number;
  };
  address?: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    formattedAddress?: string;
  };
  metadata?: {
    placeId?: string;
    osmId?: string;
    osmType?: string;
    countryCode?: string;
  };
}

export interface LocationSearchOptions {
  limit?: number;
  countryCode?: string; // Preferred camelCase
  countrycodes?: string; // Lowercase form forwarded directly to the Nominatim API
  addressdetails?: number;
  useCache?: boolean;
  bounded?: boolean;
  viewbox?: [number, number, number, number];
  cacheTTL?: number;
}
