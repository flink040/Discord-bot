import {
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { CommandDef } from '../types/Command';
import { createModerationCase } from '../moderation/case-manager';
import { fetchModerationConfig } from '../moderation/config';
import { logModerationCase } from '../moderation/logging';
import { sendModerationMessage } from '../utils/moderation';

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
  const config = await fetchModerationConfig(guild.id);
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
    await targetMember.ban({ deleteMessageSeconds: 0, reason: auditReason });
  } catch (error) {
    console.error('[ban] Fehler beim Bann:', error);
    await interaction.reply({
      content: '❌ Der Nutzer konnte nicht gebannt werden. Bitte prüfe die Bot-Berechtigungen.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (config.notifications.dmOnAction) {
    const dmLines = [
      `Du wurdest von **${guild.name}** gebannt.`,
      `Moderator: ${interaction.user.tag}`,
      `Grund: ${reason}`,
    ];

    await targetUser
      .send({ content: dmLines.join('\n') })
      .catch(() => {});
  }

  const confirmation = `✅ ${targetMember.user.tag} wurde gebannt.`;
  await interaction.reply({
    content: confirmation,
    flags: MessageFlags.Ephemeral,
  });

  const logMessage = `${interaction.user.toString()} hat <@${targetMember.id}> gebannt wegen ${reason}.`;
  await sendModerationMessage(interaction.guild, logMessage, {
    logTag: 'ban',
    category: 'bans',
  });

  try {
    const { caseRecord } = await createModerationCase({
      guildId: guild.id,
      type: 'ban',
      targetId: targetUser.id,
      targetTag: targetUser.tag,
      moderatorId: interaction.user.id,
      moderatorTag: interaction.user.tag,
      reason,
      metadata: {
        command: 'ban',
      },
    });

    await logModerationCase(guild, caseRecord);
  } catch (error) {
    console.error('[ban] Failed to persist moderation case:', error);
  }
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
