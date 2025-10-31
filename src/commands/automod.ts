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
} from '../utils/guild-feature-settings';

type AutomodInteraction = ChatInputCommandInteraction<'cached'>;

type StatusOption = 'an' | 'aus';

const data = new SlashCommandBuilder()
  .setName('automod')
  .setDescription('Aktiviert oder deaktiviert die automatische Moderation.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(option =>
    option
      .setName('status')
      .setDescription('Aktueller Zustand der automatischen Moderation.')
      .addChoices(
        { name: 'An', value: 'an' },
        { name: 'Aus', value: 'aus' },
      )
      .setRequired(true),
  );

async function ensureGuildInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<AutomodInteraction> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: '❌ Dieser Befehl kann nur innerhalb eines Servers verwendet werden.',
      flags: MessageFlags.Ephemeral,
    });
    throw new Error('automod command invoked outside of guild.');
  }
  return interaction;
}

async function requireManageGuild(interaction: AutomodInteraction) {
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
    const [modState, previousAutomodState] = await Promise.all([
      fetchModFeatureState(interaction.guildId),
      fetchAutomodState(interaction.guildId),
    ]);

    if (desiredState === 'enable' && modState !== 'enable') {
      await interaction.reply({
        content:
          '❌ Automod kann nicht aktiviert werden, solange die Moderationsfunktionen deaktiviert sind. Bitte aktiviere zuerst /togglemod.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (previousAutomodState === desiredState) {
      const unchangedMessage =
        desiredState === 'enable'
          ? 'ℹ️ Automod ist bereits aktiviert.'
          : 'ℹ️ Automod ist bereits deaktiviert.';

      await interaction.reply({
        content: unchangedMessage,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await updateAutomodState(interaction.guildId, desiredState, interaction.guild?.name);

    const successMessage =
      desiredState === 'enable'
        ? '✅ Automod wurde aktiviert.'
        : '✅ Automod wurde deaktiviert.';

    await interaction.reply({
      content: successMessage,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.error('[automod] Failed to toggle automod:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content:
          '❌ Automod konnte nicht aktualisiert werden. Bitte prüfe die Supabase-Konfiguration und versuche es erneut.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
