import { Collection, MessageFlags, SlashCommandBuilder, type ApplicationCommand, type ChatInputCommandInteraction } from 'discord.js';
import type { CommandDef } from '../types/Command';

const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Zeigt alle verfügbaren Befehle und deren Beschreibung an.');

function formatCommandList(commands: Collection<string, ApplicationCommand>): string {
  if (commands.size === 0) {
    return 'Es sind derzeit keine Befehle verfügbar.';
  }

  const sorted = Array.from(commands.values()).sort((a, b) => a.name.localeCompare(b.name));
  return sorted
    .map((command) => {
      const description = command.description?.trim() ?? '';
      const detail = description.length > 0 ? description : 'Keine Beschreibung verfügbar.';
      return `• \`/${command.name}\` – ${detail}`;
    })
    .join('\n');
}

export const execute = async (interaction: ChatInputCommandInteraction) => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const manager = interaction.client.application?.commands;
    if (!manager) {
      await interaction.editReply('❌ Ich konnte die Befehlsliste nicht abrufen. Bitte versuche es später erneut.');
      return;
    }

    const commands = await manager.fetch(
      interaction.guildId ? { guildId: interaction.guildId, force: true } : { force: true },
    );

    const helpMessage = formatCommandList(commands);
    await interaction.editReply(helpMessage);
  } catch (error) {
    console.error('[help] Failed to fetch commands', error);
    await interaction.editReply('❌ Beim Laden der Befehle ist ein Fehler aufgetreten. Bitte versuche es später erneut.');
  }
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
