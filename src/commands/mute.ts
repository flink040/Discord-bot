import {
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { CommandDef } from '../types/Command';
import { getModerationChannelId } from '../utils/moderation';

const MAX_TIMEOUT_MINUTES = 28 * 24 * 60; // Discord allows up to 28 days

function formatRemainingDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} Tag${days === 1 ? '' : 'e'}`);
  }
  if (remainingHours > 0) {
    parts.push(`${remainingHours} Stunde${remainingHours === 1 ? '' : 'n'}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} Minute${minutes === 1 ? '' : 'n'}`);
  }
  if (parts.length === 0 && seconds > 0) {
    parts.push(`${seconds} Sekunde${seconds === 1 ? '' : 'n'}`);
  }

  return parts.join(' ');
}

function assertGuildMember(member: GuildMember | null): asserts member is GuildMember {
  if (!member) {
    throw new Error('Member not found in guild.');
  }
}

export const data = new SlashCommandBuilder()
  .setName('mute')
  .setDescription('Mute einen Spieler für eine bestimmte Dauer.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(option =>
    option
      .setName('spieler')
      .setDescription('Der Spieler, der gemuted werden soll.')
      .setRequired(true),
  )
  .addIntegerOption(option =>
    option
      .setName('minuten')
      .setDescription('Dauer des Mutes in Minuten (max. 28 Tage).')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(MAX_TIMEOUT_MINUTES),
  )
  .addStringOption(option =>
    option
      .setName('grund')
      .setDescription('Grund für den Mute.')
      .setRequired(true)
      .setMaxLength(512),
  );

type MuteCommandInteraction = ChatInputCommandInteraction<'cached'>;

async function ensureGuildInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<MuteCommandInteraction> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: '❌ Dieser Befehl kann nur innerhalb eines Servers verwendet werden.',
      flags: MessageFlags.Ephemeral,
    });
    throw new Error('Mute command invoked outside of guild.');
  }
  return interaction;
}

async function requireModeratorPermission(interaction: MuteCommandInteraction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({
      content: '❌ Du benötigst die Berechtigung "Mitglieder moderieren", um diesen Befehl zu nutzen.',
      flags: MessageFlags.Ephemeral,
    });
    throw new Error('Missing permission: ModerateMembers');
  }
}

async function notifyModerationChannel(interaction: MuteCommandInteraction, message: string) {
  const channelId =
    (await getModerationChannelId(interaction.guild.id)) ?? process.env.MODERATION_CHANNEL_ID;
  if (!channelId) {
    return;
  }

  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn('[mute] Konfigurierter Moderationschannel nicht gefunden oder nicht textbasiert.');
    return;
  }

  await channel.send({ content: message }).catch((err) => {
    console.error('[mute] Fehler beim Senden der Moderationsnachricht:', err);
  });
}

export const execute = async (rawInteraction: ChatInputCommandInteraction) => {
  const interaction = await ensureGuildInteraction(rawInteraction);
  await requireModeratorPermission(interaction);

  const targetUser = interaction.options.getUser('spieler', true);
  const minutes = interaction.options.getInteger('minuten', true);
  const rawReason = interaction.options.getString('grund', true);
  const reason = rawReason.replace(/\s+/g, ' ').trim();

  if (!reason) {
    await interaction.reply({
      content: '❌ Bitte gib einen gültigen Grund für den Mute an.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (targetUser.id === interaction.user.id) {
    await interaction.reply({
      content: '❌ Du kannst dich nicht selbst muten.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guild = interaction.guild;

  const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
  assertGuildMember(targetMember);

  if (!targetMember.moderatable) {
    await interaction.reply({
      content: '❌ Ich kann diesen Nutzer nicht muten (fehlende Berechtigungen oder höhere Rolle).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existingMuteUntil = targetMember.communicationDisabledUntilTimestamp;
  if (existingMuteUntil && existingMuteUntil > Date.now()) {
    const remainingMs = existingMuteUntil - Date.now();
    const formatted = formatRemainingDuration(remainingMs) || 'wenige Sekunden';
    const absoluteTimestamp = `<t:${Math.floor(existingMuteUntil / 1000)}:f>`;
    await interaction.reply({
      content: `❌ Dieser Nutzer ist bereits gemutet und bleibt noch für ${formatted} gemutet (endet am ${absoluteTimestamp}).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const durationMs = minutes * 60 * 1000;
  const auditReason = `${reason} — Ausgeführt von ${interaction.user.tag}`.slice(0, 512);

  const safeReason = reason
    .replace(/<@!?([0-9]{17,19})>/g, '@$1')
    .replace(/@everyone/g, '@\u200beveryone')
    .replace(/@here/g, '@\u200bhere');

  try {
    await targetMember.timeout(durationMs, auditReason);
  } catch (error) {
    console.error('[mute] Fehler beim Timeout:', error);
    await interaction.reply({
      content: '❌ Der Nutzer konnte nicht gemutet werden. Bitte prüfe die Bot-Berechtigungen.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const responseMessage =
    `<@${interaction.user.id}> hat <@${targetMember.id}> für ${minutes} Minuten gemutet für ${safeReason}.`;
  await interaction.reply({
    content: responseMessage,
    flags: MessageFlags.Ephemeral,
  });

  const logMessage =
    `${interaction.user.toString()} hat <@${targetMember.id}> für ${minutes} Minuten ` +
    `gemutet für ${safeReason}.`;
  await notifyModerationChannel(interaction, logMessage);
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
