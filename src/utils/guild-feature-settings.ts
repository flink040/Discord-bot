import { getSupabaseClient } from '../supabase';

type FeatureColumn = 'mod_feature' | 'automod';

export type FeatureState = 'enable' | 'disable';

const DEFAULT_STATE: FeatureState = 'disable';

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
  } catch (error) {
    console.error('[guild-features] Failed to update automod state:', error);
    throw error;
  }
}

export function defaultFeatureState(): FeatureState {
  return DEFAULT_STATE;
}
