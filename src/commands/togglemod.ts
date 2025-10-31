import {
  ChatInputCommandInteraction,
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
    const [previousModState, previousAutomodState] = await Promise.all([
      fetchModFeatureState(interaction.guildId),
      fetchAutomodState(interaction.guildId),
    ]);

    if (previousModState === desiredState) {
      const unchangedMessage =
        desiredState === 'enable'
          ? 'ℹ️ Die Moderationsfunktionen sind bereits aktiviert.'
          : 'ℹ️ Die Moderationsfunktionen sind bereits deaktiviert.';

      await interaction.reply({
        content: unchangedMessage,
        flags: MessageFlags.Ephemeral,
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
    }

    const successMessage =
      desiredState === 'enable'
        ? '✅ Die Moderationsfunktionen wurden aktiviert.'
        : `✅ Die Moderationsfunktionen wurden deaktiviert.${extraNotice}`;

    await interaction.reply({
      content: successMessage,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.error('[togglemod] Failed to toggle moderation features:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content:
          '❌ Die Moderationsfunktionen konnten nicht aktualisiert werden. Bitte prüfe die Supabase-Konfiguration und versuche es erneut.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
