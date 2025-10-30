
import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { CommandDef } from '../types/Command';

export const data = new SlashCommandBuilder()
  .setName('about')
  .setDescription('Allgemeine Informationen.');

export const execute = async (interaction: ChatInputCommandInteraction) => {
  await interaction.reply({
    content: 'Der offizielle Discord-Bot von https://op-item-db.com/. Version 0.9',
    flags: MessageFlags.Ephemeral,
  });
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
