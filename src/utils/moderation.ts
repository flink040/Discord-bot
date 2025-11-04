import type { Guild } from 'discord.js';
import { fetchModerationConfig, updateModerationConfig } from '../moderation/config';
import { sendModerationLog } from '../moderation/logging';
import type { ModerationLogCategory } from '../moderation/types';

export async function getModerationChannelId(guildId: string): Promise<string | null> {
  const config = await fetchModerationConfig(guildId);
  return config.logChannels.moderation ?? null;
}

export async function setModerationChannelId(
  guildId: string,
  channelId: string | null,
  guildName?: string | null,
): Promise<boolean> {
  try {
    await updateModerationConfig(guildId, {
      logChannels: {
        moderation: channelId,
      },
    });

    if (guildName) {
      console.debug(
        `[moderation] Moderationschannel für ${guildName} (${guildId}) wurde auf ${channelId ?? 'entfernt'} gesetzt.`,
      );
    }

    return true;
  } catch (error) {
    console.error('[moderation] Failed to persist moderation channel:', error);
    return false;
  }
}

export async function sendModerationMessage(
  guild: Guild,
  message: string,
  options: { logTag?: string; category?: ModerationLogCategory } = {},
): Promise<boolean> {
  const { logTag = 'moderation', category = 'moderation' } = options;
  return await sendModerationLog(
    guild,
    category,
    { content: message },
    { logTag },
  );
}
