import type { Guild } from 'discord.js';
import { createGuildChannelSetting } from './channel-setting';

const adapter = createGuildChannelSetting({
  configFileName: 'moderation-channels.json',
  supabaseColumn: 'moderation_channel_id',
  envVarName: 'MODERATION_CHANNEL_STORAGE',
  logTag: 'moderation',
});

export const getModerationChannelId = adapter.getChannelId;
export const setModerationChannelId = adapter.setChannelId;

type SendModerationMessageOptions = {
  logTag?: string;
};

export async function sendModerationMessage(
  guild: Guild,
  message: string,
  { logTag = 'moderation' }: SendModerationMessageOptions = {},
): Promise<boolean> {
  const channelId = (await getModerationChannelId(guild.id)) ?? process.env.MODERATION_CHANNEL_ID;
  if (!channelId) {
    return false;
  }

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`[${logTag}] Konfigurierter Moderationschannel nicht gefunden oder nicht textbasiert.`);
    return false;
  }

  try {
    await channel.send({ content: message });
    return true;
  } catch (err) {
    console.error(`[${logTag}] Fehler beim Senden der Moderationsnachricht:`, err);
    return false;
  }
}
