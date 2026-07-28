/**
 * WhatsApp Web version resolver.
 *
 * WhatsApp validates the client build during companion-device registration: the
 * version triple is md5'd into `devicePairingData.buildHash`, and a build that is
 * too old is rejected with a 405 Connection Failure *before* any QR is issued.
 * Already-paired sessions keep working, which is why a stale version looks like
 * "QR pairing is broken" rather than "we're out of date".
 *
 * `fetchLatestBaileysVersion()` is not good enough on its own — it reads a JSON
 * file in the Baileys repo that lags the live client by weeks (it served
 * 2.3000.1035194821 while WhatsApp Web was on 2.3000.1044015310, which 405'd).
 *
 * So resolve in this order and take the highest build we can prove:
 *   1. WA_WEB_VERSION env override (escape hatch — pin without a redeploy)
 *   2. the live build scraped from web.whatsapp.com/sw.js
 *   3. the highest of fetchLatestBaileysVersion() and KNOWN_GOOD
 *
 * @module services/whatsapp/wa-version
 */

import { fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { logger } from '../../config/logger.js';

export type WAVersion = [number, number, number];

/** Last build verified to accept a fresh registration (QR issued). */
const KNOWN_GOOD: WAVersion = [2, 3000, 1044015310];

const SW_URL = 'https://web.whatsapp.com/sw.js';
const SW_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // re-check every 6h, not on every reconnect

let cached: { version: WAVersion; source: string; at: number } | null = null;

/** Parse "WA_WEB_VERSION=2.3000.1044015310" (or a bare build number). */
function parseOverride(raw: string): WAVersion | null {
  const parts = raw.trim().split('.').map(Number);
  if (parts.length === 3 && parts.every((n) => Number.isInteger(n) && n >= 0)) return parts as WAVersion;
  if (parts.length === 1 && Number.isInteger(parts[0])) return [2, 3000, parts[0]];
  return null;
}

/**
 * Scrape the live build from the service worker WhatsApp Web serves, which
 * carries `"app_version":"1044.015.310.0 (1044015310)"`. The number in brackets
 * is the third element of the Baileys version triple.
 */
async function fetchLiveVersion(): Promise<WAVersion | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SW_TIMEOUT_MS);
  try {
    const res = await fetch(SW_URL, {
      signal: controller.signal,
      headers: {
        // WhatsApp 400s anything that doesn't look like a browser fetching its own
        // service worker — the Sec-Fetch-* trio is the part it actually checks.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: '*/*',
        Referer: 'https://web.whatsapp.com/',
        'Sec-Fetch-Dest': 'serviceworker',
        'Sec-Fetch-Mode': 'same-origin',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'WA version: sw.js fetch returned non-200');
      return null;
    }
    const body = await res.text();
    const build = body.match(/app_version[^(]*\((\d{6,})\)/)?.[1];
    if (!build) {
      logger.warn('WA version: could not find app_version in sw.js');
      return null;
    }
    return [2, 3000, Number(build)];
  } catch (err) {
    logger.warn({ err }, 'WA version: sw.js fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the WA Web version to register with. Never throws — the worst case is
 * KNOWN_GOOD, which is still newer than anything Baileys ships.
 */
export async function resolveWAVersion(): Promise<WAVersion> {
  const override = process.env.WA_WEB_VERSION ? parseOverride(process.env.WA_WEB_VERSION) : null;
  if (override) {
    logger.info({ version: override }, 'WA version: using WA_WEB_VERSION override');
    return override;
  }

  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.version;

  const live = await fetchLiveVersion();
  if (live) {
    cached = { version: live, source: 'web.whatsapp.com', at: Date.now() };
    logger.info({ version: live }, 'WA version: using live web.whatsapp.com build');
    return live;
  }

  // Both fallbacks can be stale; take whichever build number is higher.
  let fallback: WAVersion = KNOWN_GOOD;
  let source = 'known-good fallback';
  try {
    const { version } = await fetchLatestBaileysVersion();
    if (version[2] > fallback[2]) {
      fallback = version as WAVersion;
      source = 'fetchLatestBaileysVersion';
    }
  } catch (err) {
    logger.warn({ err }, 'WA version: fetchLatestBaileysVersion failed');
  }

  cached = { version: fallback, source, at: Date.now() };
  logger.warn(
    { version: fallback, source },
    'WA version: live build unavailable — falling back. A fresh QR pairing may be rejected with 405 if this build is stale.'
  );
  return fallback;
}

/** Drop the cache so the next connect re-resolves (used after a 405). */
export function invalidateWAVersionCache(): void {
  cached = null;
}
