import type { Client, Guild } from 'discord.js';

import { getSupabaseClient } from '../supabase';

function hasSupabaseConfiguration(): boolean {
  return Boolean(
    process.env.SUPABASE_URL &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY),
  );
}

function normalizeGuildName(guildName: string | null | undefined): string | null {
  const trimmed = guildName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

async function upsertGuildSettingsRecord(guild: Guild): Promise<void> {
  const supabase = getSupabaseClient();
  const timestamp = new Date().toISOString();

  const payload = {
    guild_id: guild.id,
    locale: normalizeGuildName(guild.name),
    updated_at: timestamp,
  };

  const { error } = await supabase
    .from('guild_settings')
    .upsert(payload, { onConflict: 'guild_id' });

  if (error) {
    throw error;
  }
}

export async function syncGuildSettingsForClient(client: Client): Promise<void> {
  if (!hasSupabaseConfiguration()) {
    return;
  }

  const guilds = Array.from(client.guilds.cache.values());
  if (guilds.length === 0) {
    return;
  }

  await Promise.allSettled(
    guilds.map(async (guild) => {
      try {
        await upsertGuildSettingsRecord(guild);
      } catch (error) {
        console.error(`[guild-settings] Failed to sync guild ${guild.id}:`, error);
      }
    }),
  );
}

export async function syncGuildSettingsForGuild(guild: Guild): Promise<void> {
  if (!hasSupabaseConfiguration()) {
    return;
  }

  try {
    await upsertGuildSettingsRecord(guild);
  } catch (error) {
    console.error(`[guild-settings] Failed to sync guild ${guild.id}:`, error);
  }
}
