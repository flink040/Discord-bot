import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

import { getSupabaseClient } from '../supabase';

type StorageDriver = 'file' | 'supabase';

type NormalizedEnv = StorageDriver | null;

type NumberConfigMap = Record<string, number>;

export type NumberSettingOptions = {
  /** Filename within the config directory used for file-based persistence. */
  configFileName: string;
  /** Column name within the `guild_settings` table used for Supabase persistence. */
  supabaseColumn: string;
  /** Optional environment variable to force the storage driver. */
  envVarName?: string;
  /** Prefix used for log output. */
  logTag: string;
  /** Optional minimum value (inclusive). */
  minValue?: number;
  /** Optional maximum value (inclusive). */
  maxValue?: number;
};

export type NumberSettingAdapter = {
  getValue(guildId: string): Promise<number | null>;
  setValue(guildId: string, value: number | null, guildName?: string | null): Promise<boolean>;
};

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

function normalizeGuildName(guildName: string | null | undefined): string | null {
  const trimmed = guildName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeNumber(
  value: unknown,
  minValue?: number,
  maxValue?: number,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const rounded = Math.floor(numeric);
  if (minValue !== undefined && rounded < minValue) {
    return null;
  }
  if (maxValue !== undefined && rounded > maxValue) {
    return null;
  }

  return rounded;
}

function normalizeConfig(
  value: unknown,
  minValue?: number,
  maxValue?: number,
): NumberConfigMap {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const result: NumberConfigMap = {};
  for (const [guildId, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeNumber(rawValue, minValue, maxValue);
    if (normalized !== null) {
      result[guildId] = normalized;
    }
  }
  return result;
}

export function createGuildNumberSetting(options: NumberSettingOptions): NumberSettingAdapter {
  const configPath = path.join(process.cwd(), 'config', options.configFileName);
  const forcedDriver = normalizeDriverEnv(options.envVarName ? process.env[options.envVarName] : undefined);

  let inferredDriver: StorageDriver | null = null;
  let cachedFileConfig: NumberConfigMap | null = null;

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

  async function loadFileConfig(): Promise<NumberConfigMap> {
    if (cachedFileConfig) {
      return cachedFileConfig;
    }

    try {
      const raw = await readFile(configPath, 'utf8');
      cachedFileConfig = normalizeConfig(JSON.parse(raw), options.minValue, options.maxValue);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        console.error(`[${options.logTag}] Failed to read number config:`, error);
      }
      cachedFileConfig = {};
    }

    return cachedFileConfig;
  }

  async function writeFileConfig(map: NumberConfigMap): Promise<void> {
    await mkdir(path.dirname(configPath), { recursive: true });
    const payload = `${JSON.stringify(map, null, 2)}\n`;
    await writeFile(configPath, payload, 'utf8');
    cachedFileConfig = map;
  }

  function handleSupabaseFailure(error: unknown) {
    console.error(`[${options.logTag}] Failed to access number config in Supabase:`, error);
    if (!forcedDriver) {
      inferredDriver = 'file';
    }
  }

  async function getSupabaseValue(guildId: string): Promise<number | null> {
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
    const normalized = normalizeNumber(value, options.minValue, options.maxValue);
    return normalized;
  }

  async function setSupabaseValue(
    guildId: string,
    value: number | null,
    guildName?: string | null,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const timestamp = new Date().toISOString();
    const payload: Record<string, string | number | null> & { updated_at: string; guild_id: string } = {
      guild_id: guildId,
      updated_at: timestamp,
      [options.supabaseColumn]: value,
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

  async function getValue(guildId: string): Promise<number | null> {
    if (determineDriver() === 'supabase') {
      try {
        const value = await getSupabaseValue(guildId);
        if (value !== null) {
          return value;
        }
      } catch (error) {
        handleSupabaseFailure(error);
      }
    }

    const map = await loadFileConfig();
    return map[guildId] ?? null;
  }

  async function setValue(
    guildId: string,
    value: number | null,
    guildName?: string | null,
  ): Promise<boolean> {
    const normalized = normalizeNumber(value, options.minValue, options.maxValue);

    if (determineDriver() === 'supabase') {
      try {
        await setSupabaseValue(guildId, normalized, guildName);
        return true;
      } catch (error) {
        handleSupabaseFailure(error);
      }
    }

    const map = await loadFileConfig();
    const previous = map[guildId];
    const hadPrevious = Object.prototype.hasOwnProperty.call(map, guildId);

    if (normalized !== null && normalized === previous) {
      return true;
    }
    if (normalized === null && !hadPrevious) {
      return true;
    }

    if (normalized !== null) {
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
      console.error(`[${options.logTag}] Failed to write number config file:`, error);
      return false;
    }
  }

  return { getValue, setValue };
}
