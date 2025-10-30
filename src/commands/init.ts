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
import { getMarketplaceChannelId, setMarketplaceChannelId } from '../utils/marketplace';
import { findVerifiedRole, VERIFIED_ROLE_NAME } from '../utils/verification';

const MODERATION_CHANNEL_NAME = 'moderation-log';
const MARKETPLACE_CHANNEL_NAME = 'marktplatz';
const RENAME_PERMISSION_FLAGS = [
  PermissionFlagsBits.ChangeNickname,
  PermissionFlagsBits.ManageNicknames,
] as const;

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

function isSupportedGuildTextChannel(channel: GuildBasedChannel | null | undefined):
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
        const permissionsWithoutRename = guild.roles.everyone.permissions.remove(
          RENAME_PERMISSION_FLAGS,
        );
        verifiedRole = await guild.roles.create({
          name: VERIFIED_ROLE_NAME,
          mentionable: true,
          permissions: permissionsWithoutRename,
          reason: 'Initial server setup via /init',
        });
        updates.push(
          `✅ Die Rolle "${VERIFIED_ROLE_NAME}" wurde erstellt (${verifiedRole}) und erlaubt keine Nickname-Änderungen.`,
        );
      } catch (error) {
        console.error('[init] Failed to create verified role', error);
        warnings.push('⚠️ Beim Erstellen der Rolle "verifiziert" ist ein Fehler aufgetreten.');
      }
    }
  } else {
    const hasRenamePermissions = RENAME_PERMISSION_FLAGS.some(permission =>
      verifiedRole?.permissions.has(permission),
    );

    if (hasRenamePermissions) {
      if (!canManageRoles) {
        warnings.push(
          '⚠️ Die Rolle "verifiziert" erlaubt aktuell das Ändern von Nicknames, aber mir fehlt die Berechtigung **Rollen verwalten**, um das zu ändern.',
        );
      } else {
        try {
          const updatedPermissions = verifiedRole.permissions.remove(RENAME_PERMISSION_FLAGS);
          await verifiedRole.setPermissions(updatedPermissions);
          updates.push(
            `✅ Die Rolle "${VERIFIED_ROLE_NAME}" wurde aktualisiert, um das Ändern von Nicknames zu verhindern.`,
          );
        } catch (error) {
          console.error('[init] Failed to update verified role permissions', error);
          warnings.push(
            '⚠️ Die Berechtigungen der Rolle "verifiziert" konnten nicht angepasst werden, um Nickname-Änderungen zu verbieten.',
          );
        }
      }
    } else {
      updates.push(`ℹ️ Die Rolle "${VERIFIED_ROLE_NAME}" ist bereits vorhanden (${verifiedRole}).`);
    }
  }

  const existingModerationChannelId = await getModerationChannelId(guild.id);
  let moderationChannel: GuildBasedChannel | null = null;

  if (existingModerationChannelId) {
    try {
      const fetched = await guild.channels.fetch(existingModerationChannelId);
      if (isSupportedGuildTextChannel(fetched)) {
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
      channel => isSupportedGuildTextChannel(channel) && channel.name === MODERATION_CHANNEL_NAME,
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

  const existingMarketplaceChannelId = await getMarketplaceChannelId(guild.id);
  let marketplaceChannel: GuildBasedChannel | null = null;

  if (existingMarketplaceChannelId) {
    try {
      const fetched = await guild.channels.fetch(existingMarketplaceChannelId);
      if (isSupportedGuildTextChannel(fetched)) {
        marketplaceChannel = fetched;
        updates.push(`ℹ️ Marktplatz-Einträge werden bereits in ${fetched} veröffentlicht.`);
      } else {
        warnings.push('⚠️ Der gespeicherte Marktplatzchannel existiert nicht mehr oder ist kein Textchannel.');
      }
    } catch (error) {
      console.warn('[init] Failed to fetch marketplace channel', error);
      warnings.push('⚠️ Der gespeicherte Marktplatzchannel konnte nicht geladen werden.');
    }
  }

  if (!marketplaceChannel) {
    const fallback = guild.channels.cache.find(
      channel => isSupportedGuildTextChannel(channel) && channel.name === MARKETPLACE_CHANNEL_NAME,
    );

    if (fallback) {
      marketplaceChannel = fallback;
      const stored = await setMarketplaceChannelId(guild.id, fallback.id, guild.name);
      if (stored) {
        updates.push(`✅ Marktplatz-Einträge werden nun in ${fallback} veröffentlicht.`);
      } else {
        warnings.push('⚠️ Der gefundene Marktplatzchannel konnte nicht gespeichert werden.');
      }
    }
  }

  if (!marketplaceChannel) {
    if (!canManageChannels) {
      warnings.push(
        '⚠️ Ich konnte keinen Marktplatzchannel anlegen, da mir die Berechtigung **Kanäle verwalten** fehlt.',
      );
    } else {
      try {
        const created = await guild.channels.create({
          name: MARKETPLACE_CHANNEL_NAME,
          type: ChannelType.GuildText,
          reason: 'Initial server setup via /init',
        });

        marketplaceChannel = created;
        const stored = await setMarketplaceChannelId(guild.id, created.id, guild.name);
        if (stored) {
          updates.push(`✅ Der Marktplatzchannel ${created} wurde erstellt und gespeichert.`);
        } else {
          warnings.push('⚠️ Der neue Marktplatzchannel konnte nicht gespeichert werden.');
        }
      } catch (error) {
        console.error('[init] Failed to create marketplace channel', error);
        warnings.push('⚠️ Beim Erstellen des Marktplatzchannels ist ein Fehler aufgetreten.');
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
