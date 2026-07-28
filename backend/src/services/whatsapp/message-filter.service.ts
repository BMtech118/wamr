/**
 * WAMR Message Filter Service
 *
 * Provides the `shouldSendReceipt` callback for the Baileys patch.
 * After Baileys decrypts a message, this service decides whether to
 * send a delivery receipt (which suppresses phone notifications).
 *
 * Returns true (send receipt) when:
 * - Message matches the filter prefix (e.g. /request)
 * - Sender has an active conversation session (mid-flow interaction)
 * - Sender is the admin notification number
 * - Message is from self (fromMe) or a peer message
 *
 * Returns false (skip receipt) for everything else, preserving
 * phone notifications for personal WhatsApp messages.
 */

import type { proto } from '@whiskeysockets/baileys';
import { jidDecode } from '@whiskeysockets/baileys';
import { logger } from '../../config/logger.js';
import { hashingService } from '../encryption/hashing.service.js';
import { conversationSessionRepository } from '../../repositories/conversation-session.repository.js';
import { whatsappConnectionRepository } from '../../repositories/whatsapp-connection.repository.js';
import { settingRepository } from '../../repositories/setting.repository.js';
import { encryptionService } from '../encryption/encryption.service.js';

// Interactive states where follow-up messages should be processed
const ACTIVE_SESSION_STATES = [
  'AWAITING_INPUT',
  'SEARCHING',
  'AWAITING_SELECTION',
  'AWAITING_SEASON_SELECTION',
  'AWAITING_CONFIRMATION',
  'PROCESSING',
];

class MessageFilterService {
  private filterPrefix: string | null = null;
  private filterKeyword: string | null = null;
  private filterType: string | null = null;
  private adminPhoneDigits: string | null = null;
  private lastConfigRefresh = 0;
  private configRefreshInterval = 60_000; // Refresh config every 60s

  /**
   * Initialize the filter — load config from DB
   */
  async initialize(): Promise<void> {
    await this.refreshConfig();
    logger.info(
      {
        filterType: this.filterType,
        filterPrefix: this.filterPrefix,
        hasAdmin: !!this.adminPhoneDigits,
      },
      'WAMR message filter initialized'
    );
  }

  /**
   * Refresh config from DB (called periodically)
   */
  private async refreshConfig(): Promise<void> {
    try {
      // Load filter config
      const connections = await whatsappConnectionRepository.findAll();
      if (connections.length > 0) {
        this.filterType = connections[0].filterType || null;
        if (this.filterType === 'prefix') {
          this.filterPrefix = connections[0].filterValue || null;
          this.filterKeyword = null;
        } else if (this.filterType === 'keyword') {
          this.filterKeyword = connections[0].filterValue || null;
          this.filterPrefix = null;
        }
      }

      // Load admin phone number
      const phoneSetting = await settingRepository.findByKey('admin-notification-phone');
      if (phoneSetting?.value) {
        try {
          const phoneData =
            typeof phoneSetting.value === 'string'
              ? JSON.parse(phoneSetting.value as string)
              : phoneSetting.value;

          if (phoneData.encrypted) {
            const decrypted = encryptionService.decrypt(phoneData.encrypted);
            const parts = decrypted.split(':');
            const countryCode = parts[0] || '';
            const phoneNumber = parts[1] || '';
            this.adminPhoneDigits = (countryCode + phoneNumber).replace(/[^0-9]/g, '');
          } else if (phoneData.countryCode && phoneData.phoneNumber) {
            this.adminPhoneDigits = (phoneData.countryCode + phoneData.phoneNumber).replace(
              /[^0-9]/g,
              ''
            );
          }
        } catch (e) {
          logger.debug({ error: e }, 'Failed to parse admin phone for filter');
        }
      }

      this.lastConfigRefresh = Date.now();
    } catch (error) {
      logger.error({ error }, 'Failed to refresh message filter config');
    }
  }

  /**
   * The core callback — decides whether Baileys should send a delivery receipt.
   *
   * Called by the patched messages-recv.js AFTER decryption but BEFORE sendReceipt.
   * The msg object has full decrypted content available.
   */
  async shouldSendReceipt(msg: proto.IWebMessageInfo): Promise<boolean> {
    // Periodically refresh config
    if (Date.now() - this.lastConfigRefresh > this.configRefreshInterval) {
      await this.refreshConfig();
    }

    try {
      // Always process messages from self (sent from another device)
      if (msg.key?.fromMe) return true;

      // Always process group messages (shouldn't reach here, but safety)
      if (msg.key?.remoteJid?.endsWith('@g.us')) return true;

      // Extract message text
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '';

      // Check 1: Does the message match the filter?
      if (this.matchesFilter(text)) {
        logger.debug({ text: text.substring(0, 30) }, 'WAMR filter: message matches filter');
        return true;
      }

      // Extract phone number from JID for session/admin checks
      const phoneNumber = this.extractPhoneFromMsg(msg);

      if (phoneNumber) {
        // Check 2: Does the sender have an active conversation session?
        const phoneHash = hashingService.hashPhoneNumber(phoneNumber);
        const session = await conversationSessionRepository.findByPhoneHash(phoneHash);
        if (session && ACTIVE_SESSION_STATES.includes(session.state)) {
          logger.debug(
            { state: session.state, phone: phoneNumber.slice(-4) },
            'WAMR filter: sender has active session'
          );
          return true;
        }

        // Check 3: Is the sender the admin?
        if (this.adminPhoneDigits) {
          const senderDigits = phoneNumber.replace(/[^0-9]/g, '');
          if (senderDigits === this.adminPhoneDigits || senderDigits.endsWith(this.adminPhoneDigits) || this.adminPhoneDigits.endsWith(senderDigits)) {
            logger.debug('WAMR filter: message from admin');
            return true;
          }
        }
      }

      // No match — skip receipt to preserve phone notification
      logger.debug(
        {
          from: msg.key?.remoteJid?.slice(-10),
          text: text.substring(0, 20) || '(empty)',
        },
        'WAMR filter: skipping receipt for non-matching message'
      );
      return false;
    } catch (error) {
      // On error, default to sending receipt (safer — avoids breaking the session)
      logger.error({ error }, 'WAMR filter error, defaulting to send receipt');
      return true;
    }
  }

  /**
   * Check if message text matches the configured filter
   */
  private matchesFilter(text: string): boolean {
    if (!text) return false;

    if (this.filterType === 'prefix' && this.filterPrefix) {
      return text.startsWith(this.filterPrefix);
    }

    if (this.filterType === 'keyword' && this.filterKeyword) {
      return text.toLowerCase().includes(this.filterKeyword.toLowerCase());
    }

    // No filter configured — match all messages (original behavior)
    if (!this.filterType) return true;

    return false;
  }

  /**
   * Extract phone number from a Baileys message
   * Handles both PN (@s.whatsapp.net) and LID (@lid) JIDs
   */
  private extractPhoneFromMsg(msg: proto.IWebMessageInfo): string | null {
    const remoteJid = msg.key?.remoteJid || '';
    const remoteJidAlt = (msg.key as any)?.remoteJidAlt || '';

    // If primary JID is LID, try to get PN from alt
    if (remoteJid.endsWith('@lid') && remoteJidAlt.endsWith('@s.whatsapp.net')) {
      try {
        const decoded = jidDecode(remoteJidAlt);
        if (decoded?.user) return `+${decoded.user}`;
      } catch {
        // fall through
      }
    }

    // If primary JID is PN, extract directly
    if (remoteJid.endsWith('@s.whatsapp.net')) {
      try {
        const decoded = jidDecode(remoteJid);
        if (decoded?.user) return `+${decoded.user}`;
      } catch {
        // fall through
      }
    }

    return null;
  }
}

// Singleton
export const messageFilterService = new MessageFilterService();
