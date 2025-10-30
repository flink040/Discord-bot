import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

import { getSupabaseClient } from '../supabase';

type StorageDriver = 'file' | 'supabase';

export type ChannelSettingOptions = {
  /** Filename within the config directory used for file-based persistence. */
  configFileName: string;
  /** Column name within the `guild_settings` table used for Supabase persistence. */
  supabaseColumn: string;
  /** Optional environment variable to force the storage driver. */
  envVarName?: string;
  /** Prefix used for log output. */
  logTag: string;
};

export type ChannelSettingAdapter = {
  getChannelId(guildId: string): Promise<string | null>;
  setChannelId(guildId: string, channelId: string | null, guildName?: string | null): Promise<boolean>;
};

type ChannelConfigMap = Record<string, string>;

type NormalizedEnv = 'file' | 'supabase' | null;

function hasSupabaseConfiguration(): boolean {
  return Boolean(
    process.env.SUPABASE_URL &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY),
  );
}

function normalizeDriverEnv(rawValue: string | undefined): NormalizedEnv {
  const normalized = rawValue?.toLowerCase().trim();
  if (normalized === 'supabase') {
    return 'supabase';
  }
  if (normalized === 'file') {
    return 'file';
  }
  return null;
}

function normalizeConfig(value: unknown): ChannelConfigMap {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const result: ChannelConfigMap = {};
  for (const [guildId, channelId] of Object.entries(value as Record<string, unknown>)) {
    if (typeof channelId === 'string') {
      const trimmed = channelId.trim();
      if (trimmed.length > 0) {
        result[guildId] = trimmed;
      }
    }
  }
  return result;
}

function normalizeChannelId(channelId: string | null | undefined): string | null {
  const trimmed = channelId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeGuildName(guildName: string | null | undefined): string | null {
  const trimmed = guildName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function createGuildChannelSetting(options: ChannelSettingOptions): ChannelSettingAdapter {
  const configPath = path.join(process.cwd(), 'config', options.configFileName);
  const forcedDriver = normalizeDriverEnv(options.envVarName ? process.env[options.envVarName] : undefined);

  let inferredDriver: StorageDriver | null = null;
  let cachedFileConfig: ChannelConfigMap | null = null;

  function determineDriver(): StorageDriver {
    if (forcedDriver) {
      return forcedDriver;
    }
    if (inferredDriver) {
      return inferredDriver;
    }
    inferredDriver = hasSupabaseConfiguration() ? 'supabase' : 'file';
    return inferredDriver;
  }

  async function loadFileConfig(): Promise<ChannelConfigMap> {
    if (cachedFileConfig) {
      return cachedFileConfig;
    }
    try {
      const raw = await readFile(configPath, 'utf8');
      cachedFileConfig = normalizeConfig(JSON.parse(raw));
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        console.error(`[${options.logTag}] Failed to read channel config:`, error);
      }
      cachedFileConfig = {};
    }
    return cachedFileConfig;
  }

  async function writeFileConfig(map: ChannelConfigMap): Promise<void> {
    await mkdir(path.dirname(configPath), { recursive: true });
    const payload = `${JSON.stringify(map, null, 2)}\n`;
    await writeFile(configPath, payload, 'utf8');
    cachedFileConfig = map;
  }

  function handleSupabaseFailure(error: unknown) {
    console.error(`[${options.logTag}] Failed to access channel config in Supabase:`, error);
    if (!forcedDriver) {
      inferredDriver = 'file';
    }
  }

  async function getSupabaseChannel(guildId: string): Promise<string | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('guild_settings')
      .select(options.supabaseColumn)
      .eq('guild_id', guildId)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    const value = record ? record[options.supabaseColumn] : null;
    return typeof value === 'string' ? normalizeChannelId(value) : null;
  }

  async function setSupabaseChannel(
    guildId: string,
    channelId: string | null,
    guildName?: string | null,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const timestamp = new Date().toISOString();
    const payload: Record<string, string | null> & { updated_at: string; guild_id: string } = {
      guild_id: guildId,
      updated_at: timestamp,
      [options.supabaseColumn]: channelId,
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

  async function getChannelId(guildId: string): Promise<string | null> {
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

  async function setChannelId(
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
      console.error(`[${options.logTag}] Failed to write channel config file:`, error);
      return false;
    }
  }

  return { getChannelId, setChannelId };
}
