
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { CommandDef } from '../types/Command';

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Responds with pong and latency.');

export const execute = async (interaction: ChatInputCommandInteraction) => {
  const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true, ephemeral: true });
  const latency = sent.createdTimestamp - interaction.createdTimestamp;
  await interaction.editReply(`Pong! Latency: ${latency}ms`);
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
