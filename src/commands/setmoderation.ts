import {
  ChannelType,
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { CommandDef } from '../types/Command';
import { setModerationChannelId } from '../utils/moderation';

const data = new SlashCommandBuilder()
  .setName('setmoderation')
  .setDescription('Legt den Channel für Moderationsmeldungen fest.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption(option =>
    option
      .setName('channel')
      .setDescription('Textkanal, in dem Moderationsmeldungen gepostet werden sollen.')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(true),
  );

type SetModerationInteraction = ChatInputCommandInteraction<'cached'>;

async function ensureGuildInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<SetModerationInteraction> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: '❌ Dieser Befehl kann nur innerhalb eines Servers verwendet werden.',
      flags: MessageFlags.Ephemeral,
    });
    throw new Error('SetModeration command invoked outside of guild.');
  }
  return interaction;
}

async function requireManageGuild(interaction: SetModerationInteraction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: '❌ Du benötigst die Berechtigung "Server verwalten", um diesen Befehl zu nutzen.',
      flags: MessageFlags.Ephemeral,
    });
    throw new Error('Missing permission: ManageGuild');
  }
}

export const execute = async (rawInteraction: ChatInputCommandInteraction) => {
  const interaction = await ensureGuildInteraction(rawInteraction);
  await requireManageGuild(interaction);

  const channel = interaction.options.getChannel('channel', true, [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
  ]);

  if (channel.guildId !== interaction.guildId) {
    await interaction.reply({
      content: '❌ Du kannst nur Channels aus diesem Server auswählen.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const success = await setModerationChannelId(interaction.guildId, channel.id);

  if (!success) {
    await interaction.reply({
      content: '❌ Der Moderationschannel konnte nicht gespeichert werden. Bitte versuche es erneut.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: `✅ Moderationsmeldungen werden nun in ${channel} gesendet.`,
    flags: MessageFlags.Ephemeral,
  });
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
