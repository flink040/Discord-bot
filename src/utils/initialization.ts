import type { Guild } from 'discord.js';

import { defaultFeatureState, fetchModFeatureState } from './guild-feature-settings';
import { getModerationChannelId } from './moderation';
import { getMarketplaceChannelId } from './marketplace';
import { findVerifiedRole, VERIFIED_ROLE_NAME } from './verification';

const CACHE_TTL_MS = 60_000;

type CachedInitializationState = {
  expiresAt: number;
  initialized: boolean;
  missing: string[];
};

const initializationCache = new Map<string, CachedInitializationState>();

export type GuildInitializationState = {
  initialized: boolean;
  missing: string[];
};

function cacheKey(guildId: string): string {
  return guildId;
}

export function invalidateGuildInitializationCache(guildId: string): void {
  initializationCache.delete(cacheKey(guildId));
}

export async function getGuildInitializationState(guild: Guild): Promise<GuildInitializationState> {
  const key = cacheKey(guild.id);
  const cached = initializationCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { initialized: cached.initialized, missing: [...cached.missing] };
  }

  const [moderationChannelId, marketplaceChannelId, modFeatureState] = await Promise.all([
    getModerationChannelId(guild.id),
    getMarketplaceChannelId(guild.id),
    fetchModFeatureState(guild.id).catch(() => defaultFeatureState()),
  ]);

  const missing: string[] = [];

  if (modFeatureState === 'enable' && !moderationChannelId) {
    missing.push('Moderationschannel');
  }

  if (!marketplaceChannelId) {
    missing.push('Marktplatzchannel');
  }

  if (!findVerifiedRole(guild)) {
    missing.push(`Rolle "${VERIFIED_ROLE_NAME}"`);
  }

  const initialized = missing.length === 0;

  initializationCache.set(key, {
    initialized,
    missing,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return { initialized, missing };
}

