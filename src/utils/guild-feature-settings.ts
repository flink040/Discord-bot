import { getSupabaseClient } from '../supabase';

type FeatureColumn = 'mod_feature' | 'automod';

export type FeatureState = 'enable' | 'disable';

const DEFAULT_STATE: FeatureState = 'disable';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ERROR_CACHE_TTL_MS = 30 * 1000; // 30 seconds

type CacheEntry = {
  state: FeatureState;
  expiresAt: number;
};

const featureCache = new Map<string, Map<FeatureColumn, CacheEntry>>();

function normalizeGuildName(guildName: string | null | undefined): string | null {
  const trimmed = guildName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeState(value: unknown): FeatureState {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'enable') {
    return 'enable';
  }
  return 'disable';
}

function getCacheMap(guildId: string): Map<FeatureColumn, CacheEntry> {
  let byGuild = featureCache.get(guildId);
  if (!byGuild) {
    byGuild = new Map();
    featureCache.set(guildId, byGuild);
  }
  return byGuild;
}

function readCacheEntry(guildId: string, column: FeatureColumn, now: number): CacheEntry | null {
  const byGuild = featureCache.get(guildId);
  if (!byGuild) {
    return null;
  }
  const entry = byGuild.get(column);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= now) {
    byGuild.delete(column);
    if (byGuild.size === 0) {
      featureCache.delete(guildId);
    }
    return null;
  }
  return entry;
}

function writeCacheEntry(
  guildId: string,
  column: FeatureColumn,
  state: FeatureState,
  ttl: number,
  now: number,
) {
  const byGuild = getCacheMap(guildId);
  byGuild.set(column, { state, expiresAt: now + ttl });
}

async function getFeatureState(guildId: string, column: FeatureColumn): Promise<FeatureState> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('guild_settings')
    .select(column)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  const value = record ? record[column] : null;
  return normalizeState(value);
}

async function getFeatureStateCached(
  guildId: string,
  column: FeatureColumn,
): Promise<FeatureState> {
  const now = Date.now();
  const cached = readCacheEntry(guildId, column, now);
  if (cached) {
    return cached.state;
  }

  try {
    const state = await getFeatureState(guildId, column);
    writeCacheEntry(guildId, column, state, CACHE_TTL_MS, now);
    return state;
  } catch (error) {
    console.error('[guild-features] Failed to fetch cached feature state:', error);
    writeCacheEntry(guildId, column, DEFAULT_STATE, ERROR_CACHE_TTL_MS, now);
    return DEFAULT_STATE;
  }
}

async function setFeatureState(
  guildId: string,
  column: FeatureColumn,
  state: FeatureState,
  guildName?: string | null,
): Promise<void> {
  const supabase = getSupabaseClient();
  const timestamp = new Date().toISOString();

  const payload: Record<string, string | null> & { updated_at: string; guild_id: string } = {
    guild_id: guildId,
    updated_at: timestamp,
    [column]: state,
  };

  const normalizedGuildName = normalizeGuildName(guildName);
  if (normalizedGuildName) {
    payload.locale = normalizedGuildName;
  }

  const { error } = await supabase
    .from('guild_settings')
    .upsert(payload, { onConflict: 'guild_id' });

  if (error) {
    throw error;
  }
}

export async function fetchModFeatureState(guildId: string): Promise<FeatureState> {
  try {
    return await getFeatureState(guildId, 'mod_feature');
  } catch (error) {
    console.error('[guild-features] Failed to fetch mod feature state:', error);
    throw error;
  }
}

export async function fetchAutomodState(guildId: string): Promise<FeatureState> {
  try {
    return await getFeatureState(guildId, 'automod');
  } catch (error) {
    console.error('[guild-features] Failed to fetch automod state:', error);
    throw error;
  }
}

export async function getCachedAutomodState(guildId: string): Promise<FeatureState> {
  return await getFeatureStateCached(guildId, 'automod');
}

export async function updateModFeatureState(
  guildId: string,
  state: FeatureState,
  guildName?: string | null,
): Promise<void> {
  try {
    await setFeatureState(guildId, 'mod_feature', state, guildName ?? null);
  } catch (error) {
    console.error('[guild-features] Failed to update mod feature state:', error);
    throw error;
  }
}

export async function updateAutomodState(
  guildId: string,
  state: FeatureState,
  guildName?: string | null,
): Promise<void> {
  try {
    await setFeatureState(guildId, 'automod', state, guildName ?? null);
    writeCacheEntry(guildId, 'automod', state, CACHE_TTL_MS, Date.now());
  } catch (error) {
    console.error('[guild-features] Failed to update automod state:', error);
    throw error;
  }
}

export function defaultFeatureState(): FeatureState {
  return DEFAULT_STATE;
}
