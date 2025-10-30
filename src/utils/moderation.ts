import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

import { getSupabaseClient } from '../supabase';

const CONFIG_PATH = path.join(process.cwd(), 'config', 'moderation-channels.json');
const STORAGE_DRIVER_ENV = (process.env.MODERATION_CHANNEL_STORAGE ?? '').toLowerCase();
const FORCED_DRIVER =
  STORAGE_DRIVER_ENV === 'supabase'
    ? 'supabase'
    : STORAGE_DRIVER_ENV === 'file'
      ? 'file'
      : null;

type StorageDriver = 'file' | 'supabase';
type ModerationChannelMap = Record<string, string>;

let inferredDriver: StorageDriver | null = null;
let cachedFileConfig: ModerationChannelMap | null = null;

function hasSupabaseConfiguration(): boolean {
  return Boolean(
    process.env.SUPABASE_URL &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY),
  );
}

function determineDriver(): StorageDriver {
  if (FORCED_DRIVER) {
    return FORCED_DRIVER;
  }

  if (inferredDriver) {
    return inferredDriver;
  }

  inferredDriver = hasSupabaseConfiguration() ? 'supabase' : 'file';
  return inferredDriver;
}

function normalizeConfig(value: unknown): ModerationChannelMap {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const result: ModerationChannelMap = {};
  for (const [guildId, channelId] of Object.entries(value as Record<string, unknown>)) {
    if (typeof channelId === 'string' && channelId.trim().length > 0) {
      result[guildId] = channelId.trim();
    }
  }

  return result;
}

async function loadFileConfig(): Promise<ModerationChannelMap> {
  if (cachedFileConfig) {
    return cachedFileConfig;
  }

  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    cachedFileConfig = normalizeConfig(JSON.parse(raw));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      console.error('[moderation] Failed to read moderation channel config:', error);
    }
    cachedFileConfig = {};
  }

  return cachedFileConfig;
}

async function writeFileConfig(map: ModerationChannelMap): Promise<void> {
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const payload = `${JSON.stringify(map, null, 2)}\n`;
  await writeFile(CONFIG_PATH, payload, 'utf8');
  cachedFileConfig = map;
}

function normalizeChannelId(channelId: string | null | undefined): string | null {
  const trimmed = channelId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function handleSupabaseFailure(error: unknown) {
  console.error('[moderation] Failed to access moderation channel config in Supabase:', error);
  if (!FORCED_DRIVER) {
    inferredDriver = 'file';
  }
}

async function getSupabaseChannel(guildId: string): Promise<string | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('guild_settings')
    .select('moderation_channel_id')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return normalizeChannelId(data?.moderation_channel_id ?? null);
}

function normalizeGuildName(guildName: string | null | undefined): string | null {
  const trimmed = guildName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

async function setSupabaseChannel(
  guildId: string,
  channelId: string | null,
  guildName?: string | null,
): Promise<void> {
  const supabase = getSupabaseClient();
  const timestamp = new Date().toISOString();
  const normalizedGuildName = normalizeGuildName(guildName);

  const payload: Record<string, string | null> & { updated_at: string; guild_id: string } = {
    guild_id: guildId,
    moderation_channel_id: channelId,
    updated_at: timestamp,
  };

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

export async function getModerationChannelId(guildId: string): Promise<string | null> {
  if (determineDriver() === 'supabase') {
    try {
      const channelId = await getSupabaseChannel(guildId);
      if (channelId) {
        return channelId;
      }
      return null;
    } catch (error) {
      handleSupabaseFailure(error);
    }
  }

  const map = await loadFileConfig();
  return map[guildId] ?? null;
}

export async function setModerationChannelId(
  guildId: string,
  channelId: string | null,
  guildName?: string | null,
): Promise<boolean> {
  const normalized = normalizeChannelId(channelId);

  if (determineDriver() === 'supabase') {
    try {
      await setSupabaseChannel(guildId, normalized, guildName);
      return true;
    } catch (error) {
      handleSupabaseFailure(error);
    }
  }

  const map = await loadFileConfig();
  const previous = map[guildId];
  const hadPrevious = Object.prototype.hasOwnProperty.call(map, guildId);

  if (normalized && normalized === previous) {
    return true;
  }

  if (!normalized && !hadPrevious) {
    return true;
  }

  if (normalized) {
    map[guildId] = normalized;
  } else {
    delete map[guildId];
  }

  try {
    await writeFileConfig(map);
    return true;
  } catch (error) {
    if (hadPrevious) {
      map[guildId] = previous;
    } else {
      delete map[guildId];
    }
    console.error('[moderation] Failed to write moderation channel config file:', error);
    return false;
  }
}
