
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { CommandDef } from '../types/Command';

export const data = new SlashCommandBuilder()
  .setName('about')
  .setDescription('Shows basic info about this bot.');

export const execute = async (interaction: ChatInputCommandInteraction) => {
  await interaction.reply({ 
    content: 'OP-Item-DB helper bot — modular and Railway-ready. Use /ping to test availability.',
    ephemeral: true
  });
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
