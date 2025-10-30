
import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandDef } from '../types/Command';

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Responds with pong and latency.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export const execute = async (interaction: ChatInputCommandInteraction) => {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: '❌ Dieser Befehl kann nur innerhalb eines Servers verwendet werden.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: '❌ Du benötigst die Berechtigung "Server verwalten", um diesen Befehl zu nutzen.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sent = await interaction.reply({
    content: 'Pinging...',
    fetchReply: true,
    flags: MessageFlags.Ephemeral,
  });
  const latency = sent.createdTimestamp - interaction.createdTimestamp;
  await interaction.editReply(`Pong! Latency: ${latency}ms`);
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
