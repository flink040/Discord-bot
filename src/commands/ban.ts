import {
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { CommandDef } from '../types/Command';
import { getModerationChannelId } from '../utils/moderation';

function assertGuildMember(member: GuildMember | null): asserts member is GuildMember {
  if (!member) {
    throw new Error('Member not found in guild.');
  }
}

export const data = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Bannt einen Spieler vom Server.')
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addUserOption(option =>
    option
      .setName('spieler')
      .setDescription('Der Spieler, der gebannt werden soll.')
      .setRequired(true),
  )
  .addStringOption(option =>
    option
      .setName('grund')
      .setDescription('Grund für den Bann.')
      .setRequired(true)
      .setMaxLength(512),
  );

type BanCommandInteraction = ChatInputCommandInteraction<'cached'>;

async function ensureGuildInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<BanCommandInteraction> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: '❌ Dieser Befehl kann nur innerhalb eines Servers verwendet werden.',
      flags: MessageFlags.Ephemeral,
    });
    throw new Error('Ban command invoked outside of guild.');
  }
  return interaction;
}

async function requireBanPermission(interaction: BanCommandInteraction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) {
    await interaction.reply({
      content: '❌ Du benötigst die Berechtigung "Mitglieder bannen", um diesen Befehl zu nutzen.',
      flags: MessageFlags.Ephemeral,
    });
    throw new Error('Missing permission: BanMembers');
  }
}

async function notifyModerationChannel(interaction: BanCommandInteraction, message: string) {
  const channelId =
    (await getModerationChannelId(interaction.guild.id)) ?? process.env.MODERATION_CHANNEL_ID;
  if (!channelId) {
    return;
  }

  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn('[ban] Konfigurierter Moderationschannel nicht gefunden oder nicht textbasiert.');
    return;
  }

  await channel.send({ content: message }).catch((err) => {
    console.error('[ban] Fehler beim Senden der Moderationsnachricht:', err);
  });
}

export const execute = async (rawInteraction: ChatInputCommandInteraction) => {
  const interaction = await ensureGuildInteraction(rawInteraction);
  await requireBanPermission(interaction);

  const targetUser = interaction.options.getUser('spieler', true);
  const rawReason = interaction.options.getString('grund', true);
  const reason = rawReason.replace(/\s+/g, ' ').trim();

  if (!reason) {
    await interaction.reply({
      content: '❌ Bitte gib einen gültigen Grund für den Bann an.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (targetUser.id === interaction.user.id) {
    await interaction.reply({
      content: '❌ Du kannst dich nicht selbst bannen.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guild = interaction.guild;
  const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
  assertGuildMember(targetMember);

  if (!targetMember.bannable) {
    await interaction.reply({
      content: '❌ Ich kann diesen Nutzer nicht bannen (fehlende Berechtigungen oder höhere Rolle).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const auditReason = `${reason} — Ausgeführt von ${interaction.user.tag}`.slice(0, 512);

  try {
    await targetMember.ban({ deleteMessageDays: 0, reason: auditReason });
  } catch (error) {
    console.error('[ban] Fehler beim Bann:', error);
    await interaction.reply({
      content: '❌ Der Nutzer konnte nicht gebannt werden. Bitte prüfe die Bot-Berechtigungen.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const confirmation = `✅ ${targetMember.user.tag} wurde gebannt.`;
  await interaction.reply({
    content: confirmation,
    flags: MessageFlags.Ephemeral,
  });

  const logMessage = `${interaction.user.toString()} hat <@${targetMember.id}> gebannt wegen ${reason}.`;
  await notifyModerationChannel(interaction, logMessage);
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
