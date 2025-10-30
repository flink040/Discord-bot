import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getSupabaseClient } from '../supabase';

const CONFIG_FILE_NAME = 'marketplace-post-history.json';
const STORAGE_ENV_VAR = 'MARKETPLACE_CHANNEL_STORAGE';

const enum StorageDriver {
  File = 'file',
  Supabase = 'supabase',
}

type FileStore = Record<string, Record<string, string>>;

type SupabaseRow = {
  last_posted_at: string | null;
};

let cachedFileStore: FileStore | null = null;
let inferredDriver: StorageDriver | null = null;

function hasSupabaseConfiguration(): boolean {
  return Boolean(
    process.env.SUPABASE_URL &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY),
  );
}

function normalizeDriverEnv(raw: string | undefined): StorageDriver | null {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === StorageDriver.File) return StorageDriver.File;
  if (normalized === StorageDriver.Supabase) return StorageDriver.Supabase;
  return null;
}

function parseTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function determineDriver(): StorageDriver {
  const forcedDriver = normalizeDriverEnv(process.env[STORAGE_ENV_VAR]);
  if (forcedDriver) {
    return forcedDriver;
  }
  if (inferredDriver) {
    return inferredDriver;
  }
  inferredDriver = hasSupabaseConfiguration() ? StorageDriver.Supabase : StorageDriver.File;
  return inferredDriver;
}

function getConfigPath(): string {
  return path.join(process.cwd(), 'config', CONFIG_FILE_NAME);
}

async function loadFileStore(): Promise<FileStore> {
  if (cachedFileStore) {
    return cachedFileStore;
  }

  try {
    const raw = await readFile(getConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      cachedFileStore = {};
      return cachedFileStore;
    }

    const normalized: FileStore = {};
    for (const [guildId, userMap] of Object.entries(parsed as Record<string, unknown>)) {
      if (!userMap || typeof userMap !== 'object') {
        continue;
      }

      const entries: Record<string, string> = {};
      for (const [userId, timestamp] of Object.entries(userMap as Record<string, unknown>)) {
        if (typeof userId !== 'string') continue;
        const normalizedTimestamp = parseTimestamp(timestamp);
        if (normalizedTimestamp !== null) {
          entries[userId] = new Date(normalizedTimestamp).toISOString();
        }
      }

      if (Object.keys(entries).length > 0) {
        normalized[guildId] = entries;
      }
    }

    cachedFileStore = normalized;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      console.error('[marketplace-posts] Failed to read history file:', error);
    }
    cachedFileStore = {};
  }

  return cachedFileStore;
}

async function writeFileStore(store: FileStore): Promise<void> {
  await mkdir(path.dirname(getConfigPath()), { recursive: true });
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  await writeFile(getConfigPath(), payload, 'utf8');
  cachedFileStore = store;
}

function handleSupabaseFailure(error: unknown): void {
  console.error('[marketplace-posts] Supabase error:', error);
  const forced = normalizeDriverEnv(process.env[STORAGE_ENV_VAR]);
  if (!forced) {
    inferredDriver = StorageDriver.File;
  }
}

async function getSupabaseTimestamp(guildId: string, userId: string): Promise<number | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('marketplace_post_logs')
    .select('last_posted_at')
    .eq('guild_id', guildId)
    .eq('discord_user_id', userId)
    .maybeSingle<SupabaseRow>();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  const timestamp = data?.last_posted_at ?? null;
  return parseTimestamp(timestamp);
}

async function setSupabaseTimestamp(
  guildId: string,
  userId: string,
  timestampMs: number,
): Promise<void> {
  const supabase = getSupabaseClient();
  const iso = new Date(timestampMs).toISOString();
  const { error } = await supabase
    .from('marketplace_post_logs')
    .upsert(
      {
        guild_id: guildId,
        discord_user_id: userId,
        last_posted_at: iso,
      },
      { onConflict: 'guild_id,discord_user_id' },
    );

  if (error) {
    throw error;
  }
}

export async function getLastMarketplacePostTimestamp(
  guildId: string,
  userId: string,
): Promise<number | null> {
  if (determineDriver() === StorageDriver.Supabase) {
    try {
      const timestamp = await getSupabaseTimestamp(guildId, userId);
      if (timestamp !== null) {
        return timestamp;
      }
    } catch (error) {
      handleSupabaseFailure(error);
    }
  }

  const store = await loadFileStore();
  const value = store[guildId]?.[userId];
  return value ? parseTimestamp(value) : null;
}

export async function setLastMarketplacePostTimestamp(
  guildId: string,
  userId: string,
  timestampMs: number,
): Promise<boolean> {
  if (determineDriver() === StorageDriver.Supabase) {
    try {
      await setSupabaseTimestamp(guildId, userId, timestampMs);
      return true;
    } catch (error) {
      handleSupabaseFailure(error);
    }
  }

  const store = await loadFileStore();
  const previous = store[guildId]?.[userId] ?? null;
  const iso = new Date(timestampMs).toISOString();

  if (!store[guildId]) {
    store[guildId] = {};
  }

  store[guildId]![userId] = iso;

  try {
    await writeFileStore(store);
    return true;
  } catch (error) {
    console.error('[marketplace-posts] Failed to write history file:', error);
    if (previous === null) {
      delete store[guildId]![userId];
      if (Object.keys(store[guildId]!).length === 0) {
        delete store[guildId];
      }
    } else {
      store[guildId]![userId] = previous;
    }
    return false;
  }
}
