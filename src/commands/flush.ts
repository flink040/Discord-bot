import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
  type Message,
} from 'discord.js';
import type { CommandDef } from '../types/Command';

const MAX_BULK_DELETE_AGE = 14 * 24 * 60 * 60 * 1000; // 14 days in ms

type DeleteResult = {
  deleted: number;
  skippedOld: number;
};

type MessagePredicate = (message: Message) => boolean;

async function deleteMessages(
  channel: GuildTextBasedChannel,
  predicate: MessagePredicate,
): Promise<DeleteResult> {
  let before: string | undefined;
  const result: DeleteResult = { deleted: 0, skippedOld: 0 };

  while (true) {
    const fetched = await channel.messages.fetch({ limit: 100, before });
    if (fetched.size === 0) {
      break;
    }

    before = fetched.lastKey() ?? undefined;
    const matches = fetched.filter(predicate);
    if (matches.size === 0) {
      continue;
    }

    const now = Date.now();
    const deletable = matches.filter(msg => (now - msg.createdTimestamp) < MAX_BULK_DELETE_AGE && !msg.pinned);
    result.skippedOld += matches.size - deletable.size;

    if (deletable.size > 0) {
      try {
        const deleted = await channel.bulkDelete(deletable, true);
        result.deleted += deleted.size;
      } catch (err) {
        console.error('[flush] bulkDelete failed', err);
        break;
      }
    }

    // Prevent tight loop if there are no more deletable messages
    if (matches.size < fetched.size && deletable.size === 0) {
      break;
    }
  }

  return result;
}

export const data = new SlashCommandBuilder()
  .setName('flush')
  .setDescription('Löscht Nachrichten in diesem Channel.')
  .addSubcommand(sub =>
    sub
      .setName('all')
      .setDescription('Löscht alle löschbaren Nachrichten in diesem Channel.'),
  )
  .addSubcommand(sub =>
    sub
      .setName('minutes')
      .setDescription('Löscht Nachrichten der letzten X Minuten in diesem Channel.')
      .addIntegerOption(opt =>
        opt
          .setName('dauer')
          .setDescription('Anzahl der Minuten, die gelöscht werden sollen.')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(1440),
      ),
  )
  .addSubcommand(sub =>
    sub
      .setName('user')
      .setDescription('Löscht Nachrichten eines bestimmten Users aus den letzten X Minuten.')
      .addUserOption(opt =>
        opt
          .setName('ziel')
          .setDescription('Der User, dessen Nachrichten gelöscht werden sollen.')
          .setRequired(true),
      )
      .addIntegerOption(opt =>
        opt
          .setName('dauer')
          .setDescription('Anzahl der Minuten, die gelöscht werden sollen.')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(1440),
      ),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .setDMPermission(false);

export const execute = async (interaction: ChatInputCommandInteraction) => {
  if (!interaction.inGuild() || !interaction.channel) {
    await interaction.reply({
      content: 'Dieser Befehl kann nur in einem Server-Channel verwendet werden.',
      ephemeral: true,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({ content: 'Du benötigst die Berechtigung **Nachrichten verwalten**.', ephemeral: true });
    return;
  }

  if (!interaction.channel.isTextBased() || !('bulkDelete' in interaction.channel)) {
    await interaction.reply({ content: 'In diesem Channel können keine Nachrichten gelöscht werden.', ephemeral: true });
    return;
  }

  const channel = interaction.channel as GuildTextBasedChannel;
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();
  let result: DeleteResult = { deleted: 0, skippedOld: 0 };

  if (sub === 'all') {
    result = await deleteMessages(channel, () => true);
  } else if (sub === 'minutes') {
    const minutes = interaction.options.getInteger('dauer', true);
    const cutoff = Date.now() - minutes * 60_000;
    result = await deleteMessages(channel, msg => msg.createdTimestamp >= cutoff);
  } else if (sub === 'user') {
    const target = interaction.options.getUser('ziel', true);
    const minutes = interaction.options.getInteger('dauer', true);
    const cutoff = Date.now() - minutes * 60_000;
    result = await deleteMessages(channel, msg => msg.author?.id === target.id && msg.createdTimestamp >= cutoff);
  }

  let response = `✅ Es wurden ${result.deleted} Nachrichten gelöscht.`;
  if (result.skippedOld > 0) {
    response += ` ${result.skippedOld} Nachrichten waren älter als 14 Tage oder angepinnt und konnten nicht entfernt werden.`;
  }

  await interaction.editReply(response);
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
