import { getSupabaseClient } from '../supabase';

interface GuildSettingsRow {
  guild_id: string;
  moderation_channel_id: string | null;
}

export async function getModerationChannelId(guildId: string): Promise<string | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('guild_settings')
    .select('moderation_channel_id')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    console.error('[moderation] Failed to load guild settings:', error);
    return null;
  }

  const record = data as GuildSettingsRow | null;
  return record?.moderation_channel_id ?? null;
}

export async function setModerationChannelId(
  guildId: string,
  channelId: string | null,
): Promise<boolean> {
  const supabase = getSupabaseClient();
  const payload: GuildSettingsRow = {
    guild_id: guildId,
    moderation_channel_id: channelId,
  };

  const { error } = await supabase
    .from('guild_settings')
    .upsert(payload, { onConflict: 'guild_id' });

  if (error) {
    console.error('[moderation] Failed to save guild settings:', error);
    return false;
  }

  return true;
}
