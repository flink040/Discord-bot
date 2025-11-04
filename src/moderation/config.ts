import { getSupabaseClient } from '../supabase';
import type {
  DeepPartial,
  ModerationConfig,
  ModerationConfigPatch,
} from './types';

const CACHE_TTL_MS = 60 * 1000;

type CachedConfig = {
  config: ModerationConfig;
  expiresAt: number;
};

const configCache = new Map<string, CachedConfig>();

const DEFAULT_CONFIG: ModerationConfig = {
  guildId: 'unknown',
  logChannels: {
    moderation: null,
    cases: null,
    joins: null,
    leaves: null,
    nameChanges: null,
    avatarChanges: null,
    messageDeletes: null,
    messageEdits: null,
    bans: null,
    unbans: null,
    timeouts: null,
    roleChanges: null,
  },
  escalation: {
    warn: [
      {
        id: 'warn-3-timeout-1h',
        threshold: 3,
        action: {
          kind: 'timeout',
          durationMs: 60 * 60 * 1000,
          reason: 'Automatische Auszeit nach 3 Verwarnungen.',
        },
        note: 'Verstöße häufen sich – automatische Auszeit für eine Stunde.',
      },
      {
        id: 'warn-5-ban',
        threshold: 5,
        action: {
          kind: 'ban',
          reason: 'Automatischer Bann nach 5 Verwarnungen.',
        },
        note: 'Nach fünf Verwarnungen erfolgt ein automatischer Bann.',
      },
    ],
  },
  softActions: {
    allowLock: true,
    allowSlowmode: true,
    allowNick: true,
    defaultSlowmodeSeconds: 30,
    defaultLockReason: 'Temporäre Beruhigung des Channels.',
  },
  filters: {
    level: 'level1',
    reviewQueueEnabled: false,
    actions: {
      level1: { kind: 'timeout', durationMs: 15 * 60 * 1000, reason: 'Automatische Auszeit (Level 1).' },
      level2: { kind: 'timeout', durationMs: 12 * 60 * 60 * 1000, reason: 'Automatische Auszeit (Level 2).' },
      level3: { kind: 'ban', reason: 'Automatischer Bann (Level 3).' },
    },
  },
  rateLimits: {
    messagesPerSecond: 5,
    messagesPerMinute: 20,
    capsPercentage: 80,
    emojiLimit: 10,
    mentionLimit: 5,
  },
  raid: {
    spikeMemberCount: 10,
    spikeIntervalMinutes: 2,
    autoSlowmodeSeconds: 10,
    autoLockDurationMinutes: 15,
    requireVerification: true,
    captchaGate: false,
  },
  notifications: {
    dmOnAction: true,
    dmIncludeReason: true,
  },
  retention: {
    caseRetentionDays: 180,
    logRetentionDays: 180,
    anonymizeAfterDays: null,
  },
  permissions: {
    superAdminIds: [],
    roleOverrides: {},
  },
  defaults: {
    timeoutMinutes: 10,
    reasons: {
      warn: ['Allgemeine Verwarnung', 'Unangemessenes Verhalten', 'Spam'],
      mute: ['Störung der Unterhaltung', 'Spam oder Caps-Spam'],
      ban: ['Schwere Regelverletzung', 'Verstoß gegen die Serverregeln'],
      kick: ['Temporärer Ausschluss wegen Fehlverhalten'],
    },
  },
};

function cloneConfig(base: ModerationConfig): ModerationConfig {
  return JSON.parse(JSON.stringify(base)) as ModerationConfig;
}

function mergeDeep<T>(target: T, patch: DeepPartial<T>): T {
  const base: any = Array.isArray(target) ? [...(target as unknown[])] : { ...(target as Record<string, unknown>) };

  for (const [rawKey, rawValue] of Object.entries(patch as Record<string, unknown>)) {
    if (rawValue === undefined) {
      continue;
    }

    const currentValue = base[rawKey];
    const isObjectValue = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue);
    const isObjectCurrent = currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue);

    if (isObjectValue && isObjectCurrent) {
      base[rawKey] = mergeDeep(currentValue, rawValue as DeepPartial<typeof currentValue>);
    } else {
      base[rawKey] = rawValue;
    }
  }

  return base as T;
}

function hydrateConfig(guildId: string, patch?: ModerationConfigPatch | null): ModerationConfig {
  const base = cloneConfig({ ...DEFAULT_CONFIG, guildId });
  if (!patch) {
    return base;
  }
  return mergeDeep(base, patch);
}

function readCache(guildId: string): ModerationConfig | null {
  const cached = configCache.get(guildId);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt < Date.now()) {
    configCache.delete(guildId);
    return null;
  }
  return cached.config;
}

function writeCache(config: ModerationConfig) {
  configCache.set(config.guildId, {
    config,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

export function createDefaultModerationConfig(guildId: string): ModerationConfig {
  return hydrateConfig(guildId);
}

export async function fetchModerationConfig(guildId: string): Promise<ModerationConfig> {
  const cached = readCache(guildId);
  if (cached) {
    return cached;
  }

  const supabase = getSupabaseClient();

  try {
    const { data, error } = await supabase
      .from('moderation_configs')
      .select('config')
      .eq('guild_id', guildId)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    const config = hydrateConfig(guildId, (data?.config as ModerationConfigPatch | null) ?? null);
    writeCache(config);
    return config;
  } catch (error) {
    console.error('[moderation-config] Failed to fetch config – using defaults:', error);
    const fallback = hydrateConfig(guildId);
    writeCache(fallback);
    return fallback;
  }
}

export async function updateModerationConfig(
  guildId: string,
  patch: ModerationConfigPatch,
): Promise<ModerationConfig> {
  const existing = await fetchModerationConfig(guildId);
  const merged = mergeDeep(cloneConfig(existing), patch);
  merged.guildId = guildId;

  const supabase = getSupabaseClient();
  const payload = {
    guild_id: guildId,
    config: merged,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from('moderation_configs').upsert(payload, { onConflict: 'guild_id' });
  if (error) {
    console.error('[moderation-config] Failed to persist config:', error);
    throw error;
  }

  writeCache(merged);
  return merged;
}

export function invalidateModerationConfigCache(guildId: string) {
  configCache.delete(guildId);
}

export async function overwriteModerationConfig(
  guildId: string,
  config: ModerationConfig,
): Promise<ModerationConfig> {
  const supabase = getSupabaseClient();
  const normalized = cloneConfig(config);
  normalized.guildId = guildId;

  const payload = {
    guild_id: guildId,
    config: normalized,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from('moderation_configs').upsert(payload, { onConflict: 'guild_id' });
  if (error) {
    console.error('[moderation-config] Failed to overwrite config:', error);
    throw error;
  }

  writeCache(normalized);
  return normalized;
}
