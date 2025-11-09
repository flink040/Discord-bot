import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelSelectMenuInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  ComponentType,
  GuildBasedChannel,
  Message,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { CommandDef } from '../types/Command';
import {
  fetchAutomodState,
  fetchModFeatureState,
  updateAutomodState,
  updateModFeatureState,
} from '../utils/guild-feature-settings';
import {
  getModerationChannelId,
  setModerationChannelId,
} from '../utils/moderation';
import { invalidateGuildInitializationCache } from '../utils/initialization';

type ToggleModInteraction = ChatInputCommandInteraction<'cached'>;

type StatusOption = 'an' | 'aus';

const data = new SlashCommandBuilder()
  .setName('togglemod')
  .setDescription('Aktiviert oder deaktiviert die Moderationsfunktionen.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(option =>
    option
      .setName('status')
      .setDescription('Aktueller Zustand der Moderationsfunktionen.')
      .addChoices(
        { name: 'An', value: 'an' },
        { name: 'Aus', value: 'aus' },
      )
      .setRequired(true),
  );

async function ensureGuildInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<ToggleModInteraction> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: '❌ Dieser Befehl kann nur innerhalb eines Servers verwendet werden.',
      flags: MessageFlags.Ephemeral,
    });
    throw new Error('togglemod command invoked outside of guild.');
  }
  return interaction;
}

async function requireManageGuild(interaction: ToggleModInteraction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: '❌ Du benötigst die Berechtigung "Server verwalten", um diesen Befehl zu nutzen.',
      flags: MessageFlags.Ephemeral,
    });
    throw new Error('Missing permission: ManageGuild');
  }
}

function mapStatusOption(value: StatusOption): 'enable' | 'disable' {
  return value === 'an' ? 'enable' : 'disable';
}

export const execute = async (rawInteraction: ChatInputCommandInteraction) => {
  const interaction = await ensureGuildInteraction(rawInteraction);
  await requireManageGuild(interaction);

  const status = interaction.options.getString('status', true) as StatusOption;
  const desiredState = mapStatusOption(status);

  try {
    await interaction.deferReply({ ephemeral: true });

    const [previousModState, previousAutomodState] = await Promise.all([
      fetchModFeatureState(interaction.guildId),
      fetchAutomodState(interaction.guildId),
    ]);

    if (previousModState === desiredState) {
      const unchangedMessage =
        desiredState === 'enable'
          ? 'ℹ️ Die Moderationsfunktionen sind bereits aktiviert.'
          : 'ℹ️ Die Moderationsfunktionen sind bereits deaktiviert.';

      await interaction.editReply({
        content: unchangedMessage,
      });
      return;
    }

    await updateModFeatureState(interaction.guildId, desiredState, interaction.guild?.name);

    let extraNotice = '';
    if (desiredState === 'disable') {
      await updateAutomodState(interaction.guildId, 'disable', interaction.guild?.name);
      extraNotice =
        previousAutomodState === 'enable'
          ? ' Automod wurde ebenfalls deaktiviert.'
          : '';
      await interaction.editReply({
        content: `✅ Die Moderationsfunktionen wurden deaktiviert.${extraNotice}`,
      });
      return;
    }

    await interaction.editReply({
      content: '✅ Die Moderationsfunktionen wurden aktiviert.',
    });

    await promptForModerationChannel(interaction);
  } catch (error) {
    console.error('[togglemod] Failed to toggle moderation features:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content:
          '❌ Die Moderationsfunktionen konnten nicht aktualisiert werden. Bitte prüfe die Supabase-Konfiguration und versuche es erneut.',
      });
    } else {
      await interaction.reply({
        content:
          '❌ Die Moderationsfunktionen konnten nicht aktualisiert werden. Bitte prüfe die Supabase-Konfiguration und versuche es erneut.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }
};

export default { data: data.toJSON(), execute } satisfies CommandDef;

async function promptForModerationChannel(interaction: ToggleModInteraction) {
  const existingChannelId = await getModerationChannelId(interaction.guildId);
  const existingChannel = existingChannelId
    ? await resolveGuildChannel(interaction.guild.channels, existingChannelId)
    : null;

  const existingChannelDescription = existingChannel
    ? `Aktuell ist ${existingChannel} als Moderationschannel gespeichert.`
    : existingChannelId
      ? `Es ist ein gespeicherter Moderationschannel (<#${existingChannelId}>) hinterlegt, ich konnte ihn jedoch nicht finden.`
      : 'Es ist derzeit kein Moderationschannel gespeichert.';

  const basePrompt = [
    '✅ Die Moderationsfunktionen wurden aktiviert.',
    existingChannelDescription,
    '',
    'Gibt es bereits einen Moderationschannel, den ich nutzen soll?',
  ].join('\n');

  const yesNoRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('togglemod-channel-yes')
      .setLabel('Ja, bestehenden Channel auswählen')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('togglemod-channel-no')
      .setLabel('Nein, neuen Channel erstellen')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({
    content: basePrompt,
    components: [yesNoRow],
  });
  const promptMessage = (await interaction.fetchReply()) as Message;

  const filter = (componentInteraction: ButtonInteraction | ChannelSelectMenuInteraction) =>
    componentInteraction.user.id === interaction.user.id;

  let answer: 'yes' | 'no' | null = null;

  try {
    const choice = (await promptMessage.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter,
      time: 60_000,
    })) as ButtonInteraction;

    answer = choice.customId === 'togglemod-channel-yes' ? 'yes' : 'no';

    await choice.update({
      content: `${basePrompt}\n→ ${
        answer === 'yes'
          ? 'Ja, es gibt bereits einen Moderationschannel.'
          : 'Nein, es soll ein neuer Moderationschannel erstellt werden.'
      }`,
      components: [],
    });
  } catch (error) {
    console.warn('[togglemod] No response when asking for moderation channel selection', error);
    await promptMessage
      .edit({
        content: `${basePrompt}\n⚠️ Es wurde keine Auswahl getroffen. Du kannst den Moderationschannel später mit \`/setmoderation\` festlegen.`,
        components: [],
      })
      .catch(() => {});
    return;
  }

  if (answer === 'yes') {
    await handleExistingChannelSelection(interaction, filter);
  } else if (answer === 'no') {
    await handleCreateModerationChannel(interaction);
  }
}

async function handleExistingChannelSelection(
  interaction: ToggleModInteraction,
  filter: (componentInteraction: ButtonInteraction | ChannelSelectMenuInteraction) => boolean,
) {
  const channelSelectRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('togglemod-channel-select')
      .setPlaceholder('Wähle einen Moderationschannel aus')
      .setMinValues(1)
      .setMaxValues(1)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );

  const promptMessage = await interaction.followUp({
    content: 'Bitte wähle den bestehenden Moderationschannel aus.',
    components: [channelSelectRow],
    ephemeral: true,
  });

  try {
    const selection = (await promptMessage.awaitMessageComponent({
      componentType: ComponentType.ChannelSelect,
      filter,
      time: 60_000,
    })) as ChannelSelectMenuInteraction;

    const selectedChannelId = selection.values[0];
    const selectedChannel = await resolveGuildChannel(
      interaction.guild.channels,
      selectedChannelId,
    );

    if (!selectedChannel || !isSupportedModerationChannel(selectedChannel)) {
      await selection
        .update({
          content:
            '⚠️ Der ausgewählte Channel ist kein unterstützter Textchannel. Bitte versuche es erneut oder nutze `/setmoderation`.',
          components: [],
        })
        .catch(() => {});
      return;
    }

    const stored = await setModerationChannelId(
      interaction.guildId,
      selectedChannel.id,
      interaction.guild?.name,
    );

    if (!stored) {
      await selection
        .update({
          content:
            '❌ Der ausgewählte Moderationschannel konnte nicht gespeichert werden. Bitte versuche es erneut oder nutze `/setmoderation`.',
          components: [],
        })
        .catch(() => {});
      return;
    }

    invalidateGuildInitializationCache(interaction.guildId);

    await selection
      .update({
        content: `✅ Moderationsmeldungen werden nun in ${selectedChannel} gesendet.`,
        components: [],
      })
      .catch(() => {});
  } catch (error) {
    console.warn('[togglemod] No channel selected when prompted for moderation channel', error);
    await promptMessage
      .edit({
        content:
          '⚠️ Es wurde kein Channel ausgewählt. Du kannst den Moderationschannel später mit `/setmoderation` festlegen.',
        components: [],
      })
      .catch(() => {});
  }
}

async function handleCreateModerationChannel(interaction: ToggleModInteraction) {
  try {
    const createdChannel = await interaction.guild.channels.create({
      name: 'moderation',
      type: ChannelType.GuildText,
      reason: 'Moderationsfunktionen wurden über /togglemod aktiviert.',
    });

    if (!createdChannel || !isSupportedModerationChannel(createdChannel)) {
      await interaction.followUp({
        content:
          '⚠️ Es konnte kein Moderationschannel erstellt werden. Bitte überprüfe meine Berechtigungen und nutze gegebenenfalls `/setmoderation`.',
        ephemeral: true,
      });
      return;
    }

    const stored = await setModerationChannelId(
      interaction.guildId,
      createdChannel.id,
      interaction.guild?.name,
    );

    if (!stored) {
      await interaction.followUp({
        content:
          '❌ Der neu erstellte Moderationschannel konnte nicht gespeichert werden. Bitte nutze `/setmoderation`, um ihn manuell festzulegen.',
        ephemeral: true,
      });
      return;
    }

    invalidateGuildInitializationCache(interaction.guildId);

    await interaction.followUp({
      content: `✅ Ich habe ${createdChannel} als neuen Moderationschannel erstellt und hinterlegt.`,
      ephemeral: true,
    });
  } catch (error) {
    console.error('[togglemod] Failed to create moderation channel automatically', error);
    await interaction.followUp({
      content:
        '❌ Beim Erstellen des Moderationschannels ist ein Fehler aufgetreten. Bitte überprüfe meine Berechtigungen oder nutze `/setmoderation`.',
      ephemeral: true,
    });
  }
}

function isSupportedModerationChannel(channel: GuildBasedChannel | null): channel is GuildBasedChannel {
  if (!channel) {
    return false;
  }
  return channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;
}

async function resolveGuildChannel(
  manager: ToggleModInteraction['guild']['channels'],
  channelId: string,
): Promise<GuildBasedChannel | null> {
  return (
    manager.cache.get(channelId) ??
    (await manager.fetch(channelId).catch(() => null))
  );
}
