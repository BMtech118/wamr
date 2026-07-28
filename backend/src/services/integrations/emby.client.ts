/**
 * Emby API Client
 * Used to verify media is visible in Emby before notifying users
 */

import axios from 'axios';
import { logger } from '../../config/logger.js';
import { env } from '../../config/environment.js';

class EmbyClient {
  private baseUrl: string | undefined;
  private token: string | undefined;

  constructor() {
    this.baseUrl = env.EMBY_URL?.replace(/\/$/, '');
    this.token = env.EMBY_TOKEN;
  }

  /**
   * Check if Emby is configured
   */
  isConfigured(): boolean {
    return !!(this.baseUrl && this.token);
  }

  /**
   * Search Emby for a movie by title and year
   * Returns true if the item is visible in Emby's library
   */
  async isMovieVisible(title: string, year?: number | null, tmdbId?: number | null): Promise<boolean> {
    if (!this.isConfigured()) return true; // If Emby not configured, skip check

    try {
      const headers = { 'X-Emby-Token': this.token! };

      // Search by name in Emby
      const resp = await axios.get(`${this.baseUrl}/Items`, {
        headers,
        params: {
          SearchTerm: title,
          IncludeItemTypes: 'Movie',
          Recursive: true,
          Limit: 20,
        },
        timeout: 10000,
      });

      const items = resp.data?.Items || [];

      // Try to find a match by TMDB provider ID first (most accurate)
      if (tmdbId) {
        for (const item of items) {
          const providerIds = item.ProviderIds || {};
          if (providerIds.Tmdb && parseInt(providerIds.Tmdb, 10) === tmdbId) {
            logger.debug({ title, tmdbId, embyId: item.Id }, 'Movie found in Emby by TMDB ID');
            return true;
          }
        }
      }

      // Fallback: match by title and year
      for (const item of items) {
        const nameMatch = item.Name?.toLowerCase() === title.toLowerCase();
        const yearMatch = !year || item.ProductionYear === year;
        if (nameMatch && yearMatch) {
          logger.debug({ title, year, embyId: item.Id }, 'Movie found in Emby by title/year');
          return true;
        }
      }

      logger.debug({ title, year, tmdbId, resultCount: items.length }, 'Movie not yet visible in Emby');
      return false;
    } catch (error) {
      logger.error({ error, title }, 'Error checking Emby for movie visibility');
      // On error, don't block the notification
      return true;
    }
  }

  /**
   * Search Emby for a series by title
   * Returns true if the item is visible in Emby's library
   */
  async isSeriesVisible(title: string, year?: number | null, tmdbId?: number | null): Promise<boolean> {
    if (!this.isConfigured()) return true; // If Emby not configured, skip check

    try {
      const headers = { 'X-Emby-Token': this.token! };

      const resp = await axios.get(`${this.baseUrl}/Items`, {
        headers,
        params: {
          SearchTerm: title,
          IncludeItemTypes: 'Series',
          Recursive: true,
          Limit: 20,
        },
        timeout: 10000,
      });

      const items = resp.data?.Items || [];

      // Try TMDB ID match first
      if (tmdbId) {
        for (const item of items) {
          const providerIds = item.ProviderIds || {};
          if (providerIds.Tmdb && parseInt(providerIds.Tmdb, 10) === tmdbId) {
            logger.debug({ title, tmdbId, embyId: item.Id }, 'Series found in Emby by TMDB ID');
            return true;
          }
        }
      }

      // Fallback: match by title
      for (const item of items) {
        const nameMatch = item.Name?.toLowerCase() === title.toLowerCase();
        const yearMatch = !year || item.ProductionYear === year;
        if (nameMatch && yearMatch) {
          logger.debug({ title, year, embyId: item.Id }, 'Series found in Emby by title/year');
          return true;
        }
      }

      logger.debug({ title, year, tmdbId, resultCount: items.length }, 'Series not yet visible in Emby');
      return false;
    } catch (error) {
      logger.error({ error, title }, 'Error checking Emby for series visibility');
      // On error, don't block the notification
      return true;
    }
  }
}

// Export singleton
export const embyClient = new EmbyClient();
