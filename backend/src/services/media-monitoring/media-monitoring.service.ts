/**
 * Media Monitoring Service
 *
 * Periodically checks Radarr/Sonarr/Overseerr for request completion
 * and notifies users via WhatsApp when their requested media becomes available.
 *
 * TV series notifications are season-level only — one message per newly
 * completed season, no per-episode messages.
 */

import { logger } from '../../config/logger.js';
import { env } from '../../config/environment.js';
import { requestHistoryRepository } from '../../repositories/request-history.repository.js';
import { mediaServiceConfigRepository } from '../../repositories/media-service-config.repository.js';
import { OverseerrClient } from '../integrations/overseerr.client.js';
import { RadarrClient } from '../integrations/radarr.client.js';
import { SonarrClient } from '../integrations/sonarr.client.js';
import { encryptionService } from '../encryption/encryption.service.js';

/**
 * Media Monitoring Service
 * Checks for completed media requests and notifies users
 */
class MediaMonitoringService {
  private monitoringInterval: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL_MS = env.MEDIA_MONITORING_INTERVAL_MS;
  private isMonitoring = false;

  /**
   * Start monitoring for completed requests
   */
  start(): void {
    if (this.isMonitoring) {
      logger.warn('Media monitoring already running, skipping start');
      return;
    }

    this.isMonitoring = true;
    logger.info(
      {
        intervalMs: this.CHECK_INTERVAL_MS,
        intervalMinutes: parseFloat((this.CHECK_INTERVAL_MS / 60000).toFixed(2)),
      },
      'Starting media monitoring service'
    );

    // Run initial check immediately
    this.checkCompletedRequests().catch((error) => {
      logger.error({ error }, 'Error in initial media monitoring check');
    });

    // Set up periodic checks
    this.monitoringInterval = setInterval(() => {
      this.checkCompletedRequests().catch((error) => {
        logger.error({ error }, 'Error in periodic media monitoring check');
      });
    }, this.CHECK_INTERVAL_MS);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isMonitoring = false;
    logger.info('Stopped media monitoring service');
  }

  /**
   * Check all submitted requests for completion
   */
  private async checkCompletedRequests(): Promise<void> {
    try {
      logger.info('Checking for completed media requests...');

      // Get all submitted requests that haven't been marked as available
      const pendingRequests = await requestHistoryRepository.findByStatus('SUBMITTED');

      if (pendingRequests.length === 0) {
        logger.debug('No pending requests to check');
        return;
      }

      logger.info({ count: pendingRequests.length }, 'Found pending requests to check');

      for (const request of pendingRequests) {
        try {
          await this.checkRequestStatus(request);
        } catch (error) {
          logger.error(
            { requestId: request.id, title: request.title, error },
            'Error checking individual request'
          );
        }
      }

      logger.info('Completed media request check cycle');
    } catch (error) {
      logger.error({ error }, 'Error checking completed requests');
    }
  }

  /**
   * Check status of a single request
   */
  private async checkRequestStatus(request: any): Promise<void> {
    if (!request.serviceConfigId || !request.serviceType) {
      logger.warn({ requestId: request.id }, 'Request missing service info, skipping');
      return;
    }

    // Get service configuration
    const service = await mediaServiceConfigRepository.findById(request.serviceConfigId);

    if (!service || !service.enabled) {
      logger.warn(
        { requestId: request.id, serviceId: request.serviceConfigId },
        'Service not found or disabled'
      );
      return;
    }

    // Decrypt API key
    const apiKey = encryptionService.decrypt(service.apiKeyEncrypted);

    let availabilityInfo: {
      isAvailable: boolean;
      isPartial?: boolean;
      availableSeasons?: number[];
      totalSeasons?: number;
    } = { isAvailable: false };

    try {
      if (service.serviceType === 'overseerr') {
        availabilityInfo = await this.checkOverseerrStatus(service.baseUrl, apiKey, request);
      } else if (service.serviceType === 'radarr' && request.mediaType === 'movie') {
        const isAvailable = await this.checkRadarrStatus(service.baseUrl, apiKey, request);
        availabilityInfo = { isAvailable };
      } else if (service.serviceType === 'sonarr' && request.mediaType === 'series') {
        availabilityInfo = await this.checkSonarrStatus(service.baseUrl, apiKey, request);
      }

      // Handle series with season tracking (season-level only, no episode notifications)
      if (request.mediaType === 'series' && availabilityInfo.availableSeasons) {
        await this.handleSeriesSeasonUpdates(request, availabilityInfo);
      } else if (availabilityInfo.isAvailable && request.mediaType === 'movie') {
        logger.info({ requestId: request.id, title: request.title }, 'Movie has been downloaded!');

        await requestHistoryRepository.update(request.id, {
          status: 'APPROVED',
          updatedAt: new Date().toISOString(),
        });

        await this.notifyUserMediaAvailable(request, availabilityInfo);
      }
    } catch (error) {
      logger.error(
        { requestId: request.id, serviceType: service.serviceType, error },
        'Error checking service status'
      );
    }
  }

  /**
   * Check Overseerr for media availability
   */
  private async checkOverseerrStatus(
    baseUrl: string,
    apiKey: string,
    request: any
  ): Promise<{
    isAvailable: boolean;
    isPartial?: boolean;
    availableSeasons?: number[];
    totalSeasons?: number;
  }> {
    const client = new OverseerrClient(baseUrl, apiKey);

    try {
      // Search for the media to get its current status
      const searchResults = await client.search(request.title);

      // Find exact match by TMDB/TVDB ID
      const match = searchResults.results.find((result: any) => {
        if (request.mediaType === 'movie' && request.tmdbId) {
          return result.id === request.tmdbId && result.mediaType === 'movie';
        } else if (request.mediaType === 'series' && request.tmdbId) {
          return result.id === request.tmdbId && result.mediaType === 'tv';
        }
        return false;
      });

      if (!match) {
        logger.debug({ requestId: request.id }, 'Media not found in Overseerr search');
        return { isAvailable: false };
      }

      const status = match.mediaInfo?.status;

      // Status 5 = fully available, Status 4 = partially available
      const isFullyAvailable = status === 5;
      const isPartiallyAvailable = status === 4;

      // Get season details for TV series
      if ((isPartiallyAvailable || isFullyAvailable) && request.mediaType === 'series' && request.tmdbId) {
        try {
          const tvDetails = await client.getTvDetails(request.tmdbId);
          const availableSeasons: number[] = [];
          const totalSeasons = tvDetails.seasons.filter((s: any) => s.seasonNumber > 0).length;

          if (tvDetails.mediaInfo?.seasons) {
            for (const season of tvDetails.mediaInfo.seasons) {
              if (season.status === 5 || season.status === 4) {
                availableSeasons.push(season.seasonNumber);
              }
            }
          }

          return {
            isAvailable: true,
            isPartial: isPartiallyAvailable,
            availableSeasons: availableSeasons.length > 0 ? availableSeasons : undefined,
            totalSeasons,
          };
        } catch (error) {
          logger.error(
            { error, requestId: request.id },
            'Error fetching TV details from Overseerr'
          );
          return {
            isAvailable: true,
            isPartial: isPartiallyAvailable,
          };
        }
      }

      logger.debug(
        { requestId: request.id, status, isAvailable: isFullyAvailable || isPartiallyAvailable },
        'Overseerr media status'
      );

      return {
        isAvailable: isFullyAvailable || isPartiallyAvailable,
        isPartial: isPartiallyAvailable,
      };
    } catch (error) {
      logger.error({ error, requestId: request.id }, 'Error checking Overseerr status');
      return { isAvailable: false };
    }
  }

  /**
   * Handle season-level updates for TV series.
   * Sends ONE notification per cycle with all newly completed seasons.
   * Marks request as APPROVED when all available seasons have been notified
   * (treats null selectedSeasons as "all seasons").
   */
  private async handleSeriesSeasonUpdates(
    request: any,
    availabilityInfo: {
      isAvailable: boolean;
      isPartial?: boolean;
      availableSeasons?: number[];
      totalSeasons?: number;
    }
  ): Promise<void> {
    const notifiedSeasons: number[] = request.notifiedSeasons || [];
    const availableSeasons = availabilityInfo.availableSeasons || [];
    const currentTotalSeasons = availabilityInfo.totalSeasons || 0;
    const previousTotalSeasons = request.totalSeasons || 0;

    // Treat null/empty selectedSeasons as "all seasons" (fixes the bug where
    // selectedSeasons was never stored, causing requests to stay SUBMITTED forever)
    const requestedSeasons: number[] =
      request.selectedSeasons && request.selectedSeasons.length > 0
        ? request.selectedSeasons
        : availableSeasons;

    logger.debug(
      {
        requestId: request.id,
        requestedSeasons,
        notifiedSeasons,
        availableSeasons,
        currentTotalSeasons,
        previousTotalSeasons,
      },
      'Checking series season updates'
    );

    // Find newly completed seasons that haven't been notified yet
    const newlyAvailableSeasons = availableSeasons.filter(
      (season) => !notifiedSeasons.includes(season)
    );

    // Initialize total seasons tracking on first check
    if (currentTotalSeasons > 0 && previousTotalSeasons === 0) {
      await requestHistoryRepository.update(request.id, {
        totalSeasons: currentTotalSeasons,
        updatedAt: new Date().toISOString(),
      });
    }

    // Detect new season releases (total season count increased)
    if (currentTotalSeasons > previousTotalSeasons && previousTotalSeasons > 0) {
      const newSeasonNumbers: number[] = [];
      for (let i = previousTotalSeasons + 1; i <= currentTotalSeasons; i++) {
        newSeasonNumbers.push(i);
      }

      logger.info(
        {
          requestId: request.id,
          title: request.title,
          newSeasons: newSeasonNumbers,
          previousTotal: previousTotalSeasons,
          currentTotal: currentTotalSeasons,
        },
        'New seasons released - notifying user'
      );

      await this.notifyUserNewSeasonReleased(request, newSeasonNumbers);

      await requestHistoryRepository.update(request.id, {
        totalSeasons: currentTotalSeasons,
        updatedAt: new Date().toISOString(),
      });
    }

    // Send a single notification for all newly available seasons
    if (newlyAvailableSeasons.length > 0) {
      logger.info(
        {
          requestId: request.id,
          title: request.title,
          seasons: newlyAvailableSeasons,
        },
        'Seasons newly available - notifying user'
      );

      await this.notifyUserSeasonsAvailable(request, newlyAvailableSeasons);

      // Update notified seasons
      const updatedNotifiedSeasons = [...notifiedSeasons, ...newlyAvailableSeasons];
      await requestHistoryRepository.update(request.id, {
        notifiedSeasons: updatedNotifiedSeasons,
        totalSeasons: currentTotalSeasons || previousTotalSeasons,
        updatedAt: new Date().toISOString(),
      });
    }

    // Check if all requested seasons are now available — mark as APPROVED
    const allRequestedAvailable =
      requestedSeasons.length > 0 &&
      requestedSeasons.every((season) => availableSeasons.includes(season));

    if (allRequestedAvailable && request.status === 'SUBMITTED') {
      logger.info(
        { requestId: request.id, title: request.title },
        'All requested seasons now available - marking as APPROVED'
      );

      await requestHistoryRepository.update(request.id, {
        status: 'APPROVED',
        updatedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Notify user about newly available seasons — single message for all new seasons
   */
  private async notifyUserSeasonsAvailable(
    request: any,
    seasons: number[]
  ): Promise<void> {
    try {
      const phoneNumber = await this.getPhoneNumber(request);
      if (!phoneNumber) return;

      const { whatsappClientService } = await import('../whatsapp/whatsapp-client.service.js');
      const yearStr = request.year ? ` (${request.year})` : '';
      const sortedSeasons = seasons.sort((a, b) => a - b);
      const seasonList =
        sortedSeasons.length === 1
          ? `Season ${sortedSeasons[0]}`
          : sortedSeasons.length === 2
            ? `Seasons ${sortedSeasons[0]} and ${sortedSeasons[1]}`
            : `Seasons ${sortedSeasons.slice(0, -1).join(', ')} and ${sortedSeasons[sortedSeasons.length - 1]}`;

      const message =
        `🎉 *Great news!*\n\n` +
        `📺 *${request.title}${yearStr}*\n\n` +
        `✅ ${seasonList} ${seasons.length === 1 ? 'has' : 'have'} been downloaded and will usually be available to watch within an hour.`;

      await whatsappClientService.sendMessage(phoneNumber, message);

      logger.info(
        {
          requestId: request.id,
          title: request.title,
          seasons,
          phoneNumber: phoneNumber.slice(-4),
        },
        'Sent season availability notification to user'
      );
    } catch (error) {
      logger.error({ error, requestId: request.id }, 'Error sending season notification');
    }
  }

  /**
   * Notify user about new season release (total season count increased)
   */
  private async notifyUserNewSeasonReleased(request: any, newSeasons: number[]): Promise<void> {
    try {
      const phoneNumber = await this.getPhoneNumber(request);
      if (!phoneNumber) return;

      const { whatsappClientService } = await import('../whatsapp/whatsapp-client.service.js');
      const yearStr = request.year ? ` (${request.year})` : '';
      const seasonList =
        newSeasons.length === 1 ? `Season ${newSeasons[0]}` : `Seasons ${newSeasons.join(', ')}`;

      const message =
        `🆕 *New Season Announcement!*\n\n` +
        `📺 *${request.title}${yearStr}*\n\n` +
        `🎬 ${seasonList} ${newSeasons.length === 1 ? 'has' : 'have'} been announced!\n\n` +
        `${newSeasons.length === 1 ? 'It' : 'They'} may not be available yet, but we'll let you know when ${newSeasons.length === 1 ? 'it is' : 'they are'}!`;

      await whatsappClientService.sendMessage(phoneNumber, message);

      logger.info(
        {
          requestId: request.id,
          title: request.title,
          seasons: newSeasons,
          phoneNumber: phoneNumber.slice(-4),
        },
        'Sent new season announcement to user'
      );
    } catch (error) {
      logger.error({ error, requestId: request.id }, 'Error sending new season announcement');
    }
  }

  /**
   * Get phone number for notifications (helper method)
   */
  private async getPhoneNumber(request: any): Promise<string | null> {
    let phoneNumber: string | null = null;

    if (request.phoneNumberEncrypted) {
      try {
        phoneNumber = encryptionService.decrypt(request.phoneNumberEncrypted);
        logger.debug(
          { requestId: request.id, hasPhone: !!phoneNumber },
          'Decrypted phone number from request'
        );
      } catch (error) {
        logger.error({ error, requestId: request.id }, 'Failed to decrypt phone number');
      }
    }

    if (!phoneNumber) {
      const { conversationService } = await import('../conversation/conversation.service.js');
      const { conversationSessionRepository } = await import(
        '../../repositories/conversation-session.repository.js'
      );
      const session = await conversationSessionRepository.findByPhoneHash(request.phoneNumberHash);

      if (session) {
        // @ts-ignore - accessing private property for notification
        phoneNumber = conversationService.activePhoneNumbers?.get(session.id);
      }
    }

    if (!phoneNumber) {
      logger.info(
        { requestId: request.id, phoneHash: request.phoneNumberHash.slice(-4) },
        'No phone number available - user will see media next time they interact'
      );
    }

    return phoneNumber;
  }

  /**
   * Check Radarr for movie availability
   */
  private async checkRadarrStatus(baseUrl: string, apiKey: string, request: any): Promise<boolean> {
    const client = new RadarrClient(baseUrl, apiKey);

    try {
      if (!request.tmdbId) {
        logger.warn({ requestId: request.id }, 'Request missing TMDB ID for Radarr check');
        return false;
      }

      const movie = await client.getMovieByTmdbId(request.tmdbId);

      if (!movie) {
        logger.debug(
          { requestId: request.id, tmdbId: request.tmdbId },
          'Movie not found in Radarr'
        );
        return false;
      }

      const isAvailable = movie.hasFile === true;

      logger.debug(
        {
          requestId: request.id,
          title: movie.title,
          hasFile: movie.hasFile,
          monitored: movie.monitored,
          isAvailable,
        },
        'Radarr movie status'
      );

      return isAvailable;
    } catch (error) {
      logger.error({ error, requestId: request.id }, 'Error checking Radarr status');
      return false;
    }
  }

  /**
   * Check Sonarr for series availability (season-level only, no episode fetching)
   */
  private async checkSonarrStatus(
    baseUrl: string,
    apiKey: string,
    request: any
  ): Promise<{
    isAvailable: boolean;
    isPartial?: boolean;
    availableSeasons?: number[];
    totalSeasons?: number;
  }> {
    const client = new SonarrClient(baseUrl, apiKey);

    try {
      if (!request.tvdbId) {
        logger.warn({ requestId: request.id }, 'Request missing TVDB ID for Sonarr check');
        return { isAvailable: false };
      }

      const series = await client.getSeriesByTvdbId(request.tvdbId);

      if (!series) {
        logger.debug(
          { requestId: request.id, tvdbId: request.tvdbId },
          'Series not found in Sonarr'
        );
        return { isAvailable: false };
      }

      const episodeFileCount = series.statistics?.episodeFileCount ?? 0;
      const isAvailable = episodeFileCount > 0;

      // Get season-level details
      let availableSeasons: number[] = [];
      const totalSeasons = series.seasons?.length ?? 0;

      if (series.seasons) {
        availableSeasons = series.seasons
          .filter((season: any) => {
            const hasEpisodes = season.statistics?.episodeCount > 0;
            const allAiredEpisodesDownloaded =
              season.statistics?.episodeFileCount >= season.statistics?.episodeCount;
            return hasEpisodes && allAiredEpisodesDownloaded;
          })
          .map((season: any) => season.seasonNumber)
          .filter((num: number) => num > 0);
      }

      logger.debug(
        {
          requestId: request.id,
          title: series.title,
          episodeFileCount,
          totalSeasons,
          availableSeasons,
          monitored: series.monitored,
          isAvailable,
        },
        'Sonarr series status'
      );

      return {
        isAvailable,
        availableSeasons: availableSeasons.length > 0 ? availableSeasons : undefined,
        totalSeasons: totalSeasons > 0 ? totalSeasons : undefined,
      };
    } catch (error) {
      logger.error({ error, requestId: request.id }, 'Error checking Sonarr status');
      return { isAvailable: false };
    }
  }

  /**
   * Notify user via WhatsApp that their media is available
   */
  private async notifyUserMediaAvailable(
    request: any,
    availabilityInfo: {
      isAvailable: boolean;
      isPartial?: boolean;
      availableSeasons?: number[];
    }
  ): Promise<void> {
    void availabilityInfo;
    try {
      const phoneNumber = await this.getPhoneNumber(request);
      if (!phoneNumber) return;

      const { whatsappClientService } = await import('../whatsapp/whatsapp-client.service.js');

      const emoji = request.mediaType === 'movie' ? '🎬' : '📺';
      const yearStr = request.year ? ` (${request.year})` : '';

      const message =
        `🎉 *Good news!*\n\n` +
        `${emoji} *${request.title}${yearStr}* has been downloaded and will usually be available to watch within an hour.`;

      await whatsappClientService.sendMessage(phoneNumber, message);

      logger.info(
        {
          requestId: request.id,
          title: request.title,
          phoneNumber: phoneNumber.slice(-4),
        },
        'Sent availability notification to user'
      );
    } catch (error) {
      logger.error({ error, requestId: request.id }, 'Error sending availability notification');
    }
  }

  /**
   * Manually trigger a check (for testing or admin actions)
   */
  async triggerCheck(): Promise<void> {
    logger.info('Manually triggered media monitoring check');
    await this.checkCompletedRequests();
  }
}

// Export singleton instance
export const mediaMonitoringService = new MediaMonitoringService();
