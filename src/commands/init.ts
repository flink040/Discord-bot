import {
  ChannelType,
  ChatInputCommandInteraction,
  GuildBasedChannel,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { CommandDef } from '../types/Command';
import { getModerationChannelId, setModerationChannelId } from '../utils/moderation';
import { findVerifiedRole, VERIFIED_ROLE_NAME } from '../utils/verification';

const MODERATION_CHANNEL_NAME = 'moderation-log';

const data = new SlashCommandBuilder()
  .setName('init')
  .setDescription('Initialisiert den Bot auf diesem Server und richtet wichtige Ressourcen ein.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

type InitInteraction = ChatInputCommandInteraction<'cached'>;

async function ensureGuildInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<InitInteraction> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: '❌ Dieser Befehl kann nur innerhalb eines Servers verwendet werden.',
      flags: MessageFlags.Ephemeral,
    });
    throw new Error('Init command invoked outside of guild.');
  }
  return interaction;
}

async function requireManageGuild(interaction: InitInteraction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: '❌ Du benötigst die Berechtigung "Server verwalten", um diesen Befehl zu nutzen.',
      flags: MessageFlags.Ephemeral,
    });
    throw new Error('Missing permission: ManageGuild');
  }
}

function isSupportedModerationChannel(channel: GuildBasedChannel | null | undefined):
  channel is GuildBasedChannel & { type: ChannelType.GuildText | ChannelType.GuildAnnouncement } {
  return (
    !!channel &&
    (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
  );
}

export const execute = async (rawInteraction: ChatInputCommandInteraction) => {
  const interaction = await ensureGuildInteraction(rawInteraction);
  await requireManageGuild(interaction);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply('❌ Der Server konnte nicht geladen werden. Bitte versuche es erneut.');
    return;
  }

  const me = guild.members.me ?? (await guild.members.fetch(interaction.client.user.id));
  const canManageRoles = me.permissions.has(PermissionFlagsBits.ManageRoles);
  const canManageChannels = me.permissions.has(PermissionFlagsBits.ManageChannels);

  const updates: string[] = [];
  const warnings: string[] = [];

  let verifiedRole = findVerifiedRole(guild);
  if (!verifiedRole) {
    if (!canManageRoles) {
      warnings.push(
        '⚠️ Ich konnte die Rolle "verifiziert" nicht erstellen, da mir die Berechtigung **Rollen verwalten** fehlt.',
      );
    } else {
      try {
        verifiedRole = await guild.roles.create({
          name: VERIFIED_ROLE_NAME,
          mentionable: true,
          reason: 'Initial server setup via /init',
        });
        updates.push(`✅ Die Rolle "${VERIFIED_ROLE_NAME}" wurde erstellt (${verifiedRole}).`);
      } catch (error) {
        console.error('[init] Failed to create verified role', error);
        warnings.push('⚠️ Beim Erstellen der Rolle "verifiziert" ist ein Fehler aufgetreten.');
      }
    }
  } else {
    updates.push(`ℹ️ Die Rolle "${VERIFIED_ROLE_NAME}" ist bereits vorhanden (${verifiedRole}).`);
  }

  const existingModerationChannelId = await getModerationChannelId(guild.id);
  let moderationChannel: GuildBasedChannel | null = null;

  if (existingModerationChannelId) {
    try {
      const fetched = await guild.channels.fetch(existingModerationChannelId);
      if (isSupportedModerationChannel(fetched)) {
        moderationChannel = fetched;
        updates.push(`ℹ️ Moderationsmeldungen werden bereits in ${fetched} gesendet.`);
      } else {
        warnings.push('⚠️ Der gespeicherte Moderationschannel existiert nicht mehr oder ist kein Textchannel.');
      }
    } catch (error) {
      console.warn('[init] Failed to fetch moderation channel', error);
      warnings.push('⚠️ Der gespeicherte Moderationschannel konnte nicht geladen werden.');
    }
  }

  if (!moderationChannel) {
    const fallback = guild.channels.cache.find(
      channel => isSupportedModerationChannel(channel) && channel.name === MODERATION_CHANNEL_NAME,
    );

    if (fallback) {
      moderationChannel = fallback;
      const stored = await setModerationChannelId(guild.id, fallback.id, guild.name);
      if (stored) {
        updates.push(`✅ Moderationsmeldungen werden nun in ${fallback} gesendet.`);
      } else {
        warnings.push('⚠️ Der gefundene Moderationschannel konnte nicht gespeichert werden.');
      }
    }
  }

  if (!moderationChannel) {
    if (!canManageChannels) {
      warnings.push(
        '⚠️ Ich konnte keinen Moderationschannel anlegen, da mir die Berechtigung **Kanäle verwalten** fehlt.',
      );
    } else {
      try {
        const created = await guild.channels.create({
          name: MODERATION_CHANNEL_NAME,
          type: ChannelType.GuildText,
          reason: 'Initial server setup via /init',
        });

        moderationChannel = created;
        const stored = await setModerationChannelId(guild.id, created.id, guild.name);
        if (stored) {
          updates.push(`✅ Der Moderationschannel ${created} wurde erstellt und gespeichert.`);
        } else {
          warnings.push('⚠️ Der neue Moderationschannel konnte nicht gespeichert werden.');
        }
      } catch (error) {
        console.error('[init] Failed to create moderation channel', error);
        warnings.push('⚠️ Beim Erstellen des Moderationschannels ist ein Fehler aufgetreten.');
      }
    }
  }

  if (updates.length === 0) {
    updates.push('ℹ️ Es waren keine Änderungen erforderlich.');
  }

  const response = [...updates, ...warnings].join('\n');
  await interaction.editReply(response);
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
