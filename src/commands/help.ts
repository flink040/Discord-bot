import {
  ApplicationCommandOptionType,
  Collection,
  MessageFlags,
  SlashCommandBuilder,
  type APIApplicationCommandOption,
  type APIApplicationCommandOptionChoice,
  type ApplicationCommand,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandDef } from '../types/Command';

const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Zeigt alle verfügbaren Befehle und deren Beschreibung an.')
  .addStringOption(option =>
    option
      .setName('command')
      .setDescription('Zeigt Details zu einem bestimmten Befehl an.')
      .setRequired(false),
  );

function formatOptionType(type: APIApplicationCommandOption['type']): string {
  const entry = Object.entries(ApplicationCommandOptionType).find(([, value]) =>
    typeof value === 'number' && value === type,
  );
  if (!entry) {
    return 'Unbekannter Typ';
  }
  const [rawName] = entry;
  return rawName.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function formatOptions(
  options: readonly APIApplicationCommandOption[] | undefined,
  depth = 0,
): string {
  if (!options || options.length === 0) {
    return depth === 0 ? '_Keine Optionen verfügbar._' : '';
  }

  return options
    .map(option => {
      const indent = depth > 0 ? '   '.repeat(depth) : '';
      const description = option.description?.trim() ?? 'Keine Beschreibung verfügbar.';
      const required = option.required ? ' (erforderlich)' : '';
      const typeLabel = formatOptionType(option.type);
      const baseLine = `${indent}• \`${option.name}\` – ${description} [${typeLabel}${required}]`;

      const hasChoices = 'choices' in option && Array.isArray(option.choices) && option.choices.length > 0;
      const choiceList = hasChoices
        ? (option.choices as readonly APIApplicationCommandOptionChoice[])
        : undefined;
      const choices = choiceList
        ? `\n${indent}  Wahlmöglichkeiten: ${choiceList
            .map(choice => `\`${choice.name}\``)
            .join(', ')}`
        : '';

      const nested = 'options' in option ? formatOptions(option.options, depth + 1) : '';
      const nestedBlock = nested ? `\n${nested}` : '';

      return `${baseLine}${choices}${nestedBlock}`;
    })
    .join('\n');
}

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

function formatCommandDetail(command: ApplicationCommand, commands: Collection<string, ApplicationCommand>): string {
  const description = command.description?.trim() ?? 'Keine Beschreibung verfügbar.';
  const permissions = command.defaultMemberPermissions?.toArray() ?? [];
  const permissionLine =
    permissions.length > 0
      ? `Benötigte Berechtigungen: ${permissions.map(perm => `\`${perm}\``).join(', ')}`
      : 'Benötigte Berechtigungen: Keine speziellen Berechtigungen erforderlich.';

  const dmAvailability = command.dmPermission === false ? '❌ Nein' : '✅ Ja';
  const optionsBlock = formatOptions(command.options as APIApplicationCommandOption[] | undefined);
  const availableList = formatCommandList(commands);

  return [
    `**/${command.name}**`,
    description,
    '',
    permissionLine,
    `In Direktnachrichten verfügbar: ${dmAvailability}`,
    '',
    '**Optionen**',
    optionsBlock,
    '',
    '**Weitere Befehle**',
    availableList,
  ]
    .filter(Boolean)
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

    const requestedCommand = interaction.options.getString('command');

    if (requestedCommand) {
      const command = commands.find(cmd => cmd.name.toLowerCase() === requestedCommand.toLowerCase());
      if (!command) {
        const available = formatCommandList(commands);
        await interaction.editReply(
          `❌ Der Befehl \`${requestedCommand}\` wurde nicht gefunden. Verfügbare Befehle:\n${available}`,
        );
        return;
      }

      const details = formatCommandDetail(command, commands);
      await interaction.editReply(details);
      return;
    }

    const helpMessage = formatCommandList(commands);
    await interaction.editReply(helpMessage);
  } catch (error) {
    console.error('[help] Failed to fetch commands', error);
    await interaction.editReply('❌ Beim Laden der Befehle ist ein Fehler aufgetreten. Bitte versuche es später erneut.');
  }
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
