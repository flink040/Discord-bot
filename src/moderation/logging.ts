import {
  Colors,
  EmbedBuilder,
  type Guild,
  type MessageCreateOptions,
  type PartialGroupDMChannel,
  type TextBasedChannel,
} from 'discord.js';
import { formatDuration } from '../utils/time';
import { fetchModerationConfig } from './config';
import type {
  ModerationCaseLogOptions,
  ModerationCaseRecord,
  ModerationLogCategory,
} from './types';

type SendLogOptions = {
  logTag?: string;
};

type SendableChannel = Exclude<TextBasedChannel, PartialGroupDMChannel>;

async function resolveLogChannel(
  guild: Guild,
  category: ModerationLogCategory,
): Promise<SendableChannel | null> {
  const config = await fetchModerationConfig(guild.id);
  const channelId = config.logChannels[category] ?? null;
  const fallbackModerationId = config.logChannels.moderation ?? null;
  const finalChannelId = channelId ?? fallbackModerationId ?? null;
  if (!finalChannelId) {
    return null;
  }

  const channel = await guild.channels.fetch(finalChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return null;
  }
  return channel as SendableChannel;
}

export async function sendModerationLog(
  guild: Guild,
  category: ModerationLogCategory,
  payload: MessageCreateOptions,
  options: SendLogOptions = {},
): Promise<boolean> {
  const channel = await resolveLogChannel(guild, category);
  if (!channel) {
    if (options.logTag) {
      console.warn(`[${options.logTag}] Kein Log-Channel für ${category} konfiguriert.`);
    }
    return false;
  }

  try {
    await channel.send(payload);
    return true;
  } catch (error) {
    console.error(`[${options.logTag ?? 'moderation-log'}] Fehler beim Senden des Logs:`, error);
    return false;
  }
}

function formatCaseTitle(record: ModerationCaseRecord): string {
  const prefix = record.case_number ? `Fall #${record.case_number}` : 'Moderationsfall';
  return `${prefix}: ${record.type.toUpperCase()}`;
}

function buildCaseEmbed(
  guild: Guild,
  record: ModerationCaseRecord,
  options: ModerationCaseLogOptions = {},
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(formatCaseTitle(record))
    .addFields(
      { name: 'Aktion', value: record.type.toUpperCase(), inline: true },
      { name: 'Ziel', value: `<@${record.target_id}> (${record.target_tag})`, inline: true },
      { name: 'Moderator', value: `<@${record.moderator_id}> (${record.moderator_tag})`, inline: true },
    )
    .setTimestamp(new Date(record.created_at))
    .setFooter({ text: guild.name });

  if (record.reason) {
    embed.addFields({ name: 'Grund', value: record.reason });
  }

  if (record.duration_ms && record.duration_ms > 0) {
    const formattedDuration = formatDuration(record.duration_ms) ?? `${Math.round(record.duration_ms / 1000)} Sekunden`;
    const endsAt = Math.floor((new Date(record.created_at).getTime() + record.duration_ms) / 1000);
    embed.addFields({ name: 'Dauer', value: `${formattedDuration} (endet <t:${endsAt}:R>)` });
  }

  if (record.severity) {
    embed.addFields({ name: 'Schweregrad', value: record.severity });
  }

  if (options.additionalFields?.length) {
    embed.addFields(options.additionalFields);
  }

  return embed;
}

export async function logModerationCase(
  guild: Guild,
  record: ModerationCaseRecord,
  options?: ModerationCaseLogOptions,
): Promise<boolean> {
  const embed = buildCaseEmbed(guild, record, options);
  return await sendModerationLog(guild, 'cases', { embeds: [embed] }, { logTag: 'moderation-case' });
}
