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
  MessageComponentInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { CommandDef } from '../types/Command';
import { getModerationChannelId, setModerationChannelId } from '../utils/moderation';
import {
  DEFAULT_MARKETPLACE_POST_INTERVAL_HOURS,
  getMarketplaceChannelId,
  getMarketplacePostIntervalHours,
  setMarketplaceChannelId,
  setMarketplacePostIntervalHours,
} from '../utils/marketplace';
import { findVerifiedRole, VERIFIED_ROLE_NAME } from '../utils/verification';
import { invalidateGuildInitializationCache } from '../utils/initialization';

const MODERATION_CHANNEL_NAME = 'moderation-log';
const MARKETPLACE_CHANNEL_NAME = 'marktplatz';
const RENAME_PERMISSION_FLAGS = [
  PermissionFlagsBits.ChangeNickname,
  PermissionFlagsBits.ManageNicknames,
] as const;

type SupportedGuildTextChannel = GuildBasedChannel & {
  type: ChannelType.GuildText | ChannelType.GuildAnnouncement;
};

const data = new SlashCommandBuilder()
  .setName('init')
  .setDescription('Initialisiert den Bot auf diesem Server und richtet wichtige Ressourcen ein.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addIntegerOption(option =>
    option
      .setName('marktplatz_intervall')
      .setDescription('Mindestabstand in Stunden zwischen den Marktplatz-Beiträgen eines Nutzers.')
      .setMinValue(1),
  );

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
  channel is SupportedGuildTextChannel {
  return (
    !!channel &&
    (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
  );
}

export const execute = async (rawInteraction: ChatInputCommandInteraction) => {
  const interaction = await ensureGuildInteraction(rawInteraction);
  await requireManageGuild(interaction);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let guildIdForInvalidation: string | null = null;

  try {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply('❌ Der Server konnte nicht geladen werden. Bitte versuche es erneut.');
      return;
    }

    guildIdForInvalidation = guild.id;

    const me = guild.members.me ?? (await guild.members.fetch(interaction.client.user.id));

    const requiredPermissions: Array<[bigint, string]> = [
      [PermissionFlagsBits.ManageRoles, 'Rollen verwalten'],
      [PermissionFlagsBits.ManageChannels, 'Kanäle verwalten'],
    ];

    const missingPermissions = requiredPermissions.filter(
      ([permission]) => !me.permissions.has(permission),
    );

    if (missingPermissions.length > 0) {
      const missingList = missingPermissions.map(([, label]) => `• ${label}`).join('\n');
      await interaction.editReply(
        [
          '❌ Ich habe nicht alle benötigten Berechtigungen, um die Einrichtung abzuschließen.',
          'Bitte gewähre mir die folgenden Berechtigungen und versuche es anschließend erneut:',
          missingList,
        ].join('\n'),
      );
      return;
    }
    const requestedMarketplaceInterval = interaction.options.getInteger('marktplatz_intervall');
    const canManageRoles = me.permissions.has(PermissionFlagsBits.ManageRoles);
    const canManageChannels = me.permissions.has(PermissionFlagsBits.ManageChannels);

    const updates: string[] = [];
    const warnings: string[] = [];

    await interaction.editReply('✅ Lass uns die Einrichtung Schritt für Schritt durchführen.');

    const filter = (componentInteraction: MessageComponentInteraction) =>
      componentInteraction.user.id === interaction.user.id;

    const askYesNo = async (
      question: string,
      customIdPrefix: string,
      timeoutWarning: string,
    ): Promise<boolean | null> => {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${customIdPrefix}-yes`).setLabel('Ja').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${customIdPrefix}-no`).setLabel('Nein').setStyle(ButtonStyle.Secondary),
      );

      const promptMessage = await interaction.followUp({
        content: question,
        components: [row],
        ephemeral: true,
      });

      try {
        const choice = (await promptMessage.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter,
          time: 60_000,
        })) as ButtonInteraction;

        const answerIsYes = choice.customId === `${customIdPrefix}-yes`;
        await choice.update({
          content: `${question}\n→ ${answerIsYes ? 'Ja' : 'Nein'}`,
          components: [],
        });
        return answerIsYes;
      } catch (error) {
        console.warn(`[init] No response for ${customIdPrefix} prompt`, error);
        await promptMessage
          .edit({ content: `${question}\n⚠️ Es wurde keine Auswahl getroffen.`, components: [] })
          .catch(() => {});
        warnings.push(timeoutWarning);
        return null;
      }
    };

    const askChannelSelection = async (
      question: string,
      customId: string,
      invalidTypeWarning: string,
      timeoutWarning: string,
    ): Promise<SupportedGuildTextChannel | null> => {
      const channelSelectRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(customId)
          .setPlaceholder('Wähle einen Channel aus')
          .setMinValues(1)
          .setMaxValues(1)
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      );

      const promptMessage = await interaction.followUp({
        content: question,
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
        const selectedChannel =
          guild.channels.cache.get(selectedChannelId) ?? (await guild.channels.fetch(selectedChannelId).catch(() => null));

        if (isSupportedGuildTextChannel(selectedChannel)) {
          await selection.update({ content: `${question}\n→ ${selectedChannel}`, components: [] });
          return selectedChannel;
        }

        await selection
          .update({
            content: `${question}\n⚠️ Der ausgewählte Channel ist kein Textchannel.`,
            components: [],
          })
          .catch(() => {});
        warnings.push(invalidTypeWarning);
      } catch (error) {
        console.warn(`[init] Channel selection (${customId}) failed`, error);
        await promptMessage
          .edit({ content: `${question}\n⚠️ Es wurde kein Channel ausgewählt.`, components: [] })
          .catch(() => {});
        warnings.push(timeoutWarning);
      }

      return null;
    };

    let verifiedRole = findVerifiedRole(guild);
    const verificationChoice = await askYesNo(
      'Möchtest du das Verifizierungs-Feature nutzen?',
      'init-verification',
      '⚠️ Es wurde nicht entschieden, ob das Verifizierungs-Feature eingerichtet werden soll.',
    );

    if (verificationChoice === true) {
      if (!verifiedRole) {
        if (!canManageRoles) {
          warnings.push(
            `⚠️ Ich konnte die Rolle "${VERIFIED_ROLE_NAME}" nicht erstellen, da mir die Berechtigung **Rollen verwalten** fehlt.`,
          );
        } else {
          try {
            const permissionsWithoutRename = guild.roles.everyone.permissions.remove(RENAME_PERMISSION_FLAGS);
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
            warnings.push(`⚠️ Beim Erstellen der Rolle "${VERIFIED_ROLE_NAME}" ist ein Fehler aufgetreten.`);
          }
        }
      } else {
        const hasRenamePermissions = RENAME_PERMISSION_FLAGS.some(permission =>
          verifiedRole?.permissions.has(permission),
        );

        if (hasRenamePermissions) {
          if (!canManageRoles) {
            warnings.push(
              `⚠️ Die Rolle "${VERIFIED_ROLE_NAME}" erlaubt aktuell das Ändern von Nicknames, aber mir fehlt die Berechtigung **Rollen verwalten**, um das zu ändern.`,
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
                `⚠️ Die Berechtigungen der Rolle "${VERIFIED_ROLE_NAME}" konnten nicht angepasst werden, um Nickname-Änderungen zu verbieten.`,
              );
            }
          }
        } else {
          updates.push(`ℹ️ Die Rolle "${VERIFIED_ROLE_NAME}" ist bereits vorhanden (${verifiedRole}).`);
        }
      }
    } else if (verificationChoice === false) {
      if (verifiedRole) {
        updates.push(`ℹ️ Die Rolle "${VERIFIED_ROLE_NAME}" bleibt unverändert, das Feature wurde deaktiviert.`);
      } else {
        updates.push('ℹ️ Das Verifizierungs-Feature wurde übersprungen.');
      }
    }

    const existingMarketplaceChannelId = await getMarketplaceChannelId(guild.id);
    let marketplacePostIntervalHours = await getMarketplacePostIntervalHours(guild.id);
    let marketplaceChannel: SupportedGuildTextChannel | null = null;

    const hasMarketplaceChannel = await askYesNo(
      'Hast du einen Handelschannel?',
      'init-marketplace-have',
      '⚠️ Es wurde nicht festgelegt, ob ein Handelschannel vorhanden ist.',
    );

    if (hasMarketplaceChannel === true) {
      const selectedChannel = await askChannelSelection(
        'Welcher Channel soll für Handelsangebote verwendet werden?',
        'init-marketplace-select',
        '⚠️ Der ausgewählte Channel für den Handel ist kein Textchannel.',
        '⚠️ Es wurde kein Channel für den Handel ausgewählt.',
      );

      if (selectedChannel) {
        marketplaceChannel = selectedChannel;
        const stored = await setMarketplaceChannelId(guild.id, selectedChannel.id, guild.name);
        if (stored) {
          updates.push(`✅ Marktplatz-Einträge werden nun in ${selectedChannel} veröffentlicht.`);
        } else {
          warnings.push('⚠️ Der ausgewählte Marktplatzchannel konnte nicht gespeichert werden.');
        }
      }
    } else if (hasMarketplaceChannel === false) {
      if (!canManageChannels) {
        warnings.push(
          '⚠️ Ich konnte keinen Handelschannel erstellen, da mir die Berechtigung **Kanäle verwalten** fehlt.',
        );
      } else {
        try {
          const created = await guild.channels.create({
            name: MARKETPLACE_CHANNEL_NAME,
            type: ChannelType.GuildText,
            reason: 'Initial server setup via /init (Handelschannel)',
          });
          marketplaceChannel = created as SupportedGuildTextChannel;
          const stored = await setMarketplaceChannelId(guild.id, created.id, guild.name);
          if (stored) {
            updates.push(`✅ Der Handelschannel ${created} wurde erstellt und gespeichert.`);
          } else {
            warnings.push('⚠️ Der neue Handelschannel konnte nicht gespeichert werden.');
          }
        } catch (error) {
          console.error('[init] Failed to create marketplace channel', error);
          warnings.push('⚠️ Beim Erstellen des Handelschannels ist ein Fehler aufgetreten.');
        }
      }
    }

    if (!marketplaceChannel && hasMarketplaceChannel !== null && existingMarketplaceChannelId) {
      try {
        const fallback = await guild.channels
          .fetch(existingMarketplaceChannelId)
          .catch(() => null);
        if (isSupportedGuildTextChannel(fallback)) {
          updates.push(`ℹ️ Der bisher gespeicherte Handelschannel (${fallback}) bleibt unverändert.`);
        }
      } catch (error) {
        console.warn('[init] Failed to keep previous marketplace channel', error);
      }
    }

    if (marketplaceChannel) {
      const intervalToPersist =
        requestedMarketplaceInterval ??
        marketplacePostIntervalHours ??
        DEFAULT_MARKETPLACE_POST_INTERVAL_HOURS;

      if (marketplacePostIntervalHours !== intervalToPersist) {
        const storedInterval = await setMarketplacePostIntervalHours(
          guild.id,
          intervalToPersist,
          guild.name,
        );

        if (storedInterval) {
          marketplacePostIntervalHours = intervalToPersist;
          if (requestedMarketplaceInterval !== null) {
            updates.push(`✅ Der Marktplatz-Post-Intervall wurde auf ${intervalToPersist} Stunden festgelegt.`);
          } else if (intervalToPersist === DEFAULT_MARKETPLACE_POST_INTERVAL_HOURS) {
            updates.push(
              `✅ Der Marktplatz-Post-Intervall wurde auf den Standardwert von ${intervalToPersist} Stunden gesetzt.`,
            );
          } else {
            updates.push(`✅ Der Marktplatz-Post-Intervall wurde auf ${intervalToPersist} Stunden aktualisiert.`);
          }
        } else {
          warnings.push('⚠️ Der Marktplatz-Post-Intervall konnte nicht gespeichert werden.');
        }
      } else if (marketplacePostIntervalHours !== null) {
        updates.push(`ℹ️ Der Marktplatz-Post-Intervall bleibt bei ${marketplacePostIntervalHours} Stunden.`);
      }
    } else if (requestedMarketplaceInterval !== null) {
      warnings.push(
        '⚠️ Es konnte kein Handelschannel eingerichtet werden, daher wurde kein Post-Intervall gespeichert.',
      );
    }

    const existingModerationChannelId = await getModerationChannelId(guild.id);
    let moderationChannel: SupportedGuildTextChannel | null = null;

    const moderationChoice = await askYesNo(
      'Möchtest du das Moderationsfeature nutzen?',
      'init-moderation-use',
      '⚠️ Es wurde nicht entschieden, ob das Moderationsfeature genutzt werden soll.',
    );

    if (moderationChoice === true) {
      const moderationHasChannel = await askYesNo(
        'Gibt es bereits einen Channel für Moderationsmeldungen?',
        'init-moderation-have',
        '⚠️ Es wurde nicht festgelegt, ob ein Moderationschannel vorhanden ist.',
      );

      if (moderationHasChannel === true) {
        const selectedChannel = await askChannelSelection(
          'Welcher Channel soll für Moderationsmeldungen verwendet werden?',
          'init-moderation-select',
          '⚠️ Der ausgewählte Channel für Moderationsmeldungen ist kein Textchannel.',
          '⚠️ Es wurde kein Channel für Moderationsmeldungen ausgewählt.',
        );

        if (selectedChannel) {
          moderationChannel = selectedChannel;
          const stored = await setModerationChannelId(guild.id, selectedChannel.id, guild.name);
          if (stored) {
            updates.push(`✅ Moderationsmeldungen werden nun in ${selectedChannel} gesendet.`);
          } else {
            warnings.push('⚠️ Der ausgewählte Moderationschannel konnte nicht gespeichert werden.');
          }
        }
      } else if (moderationHasChannel === false) {
        if (!canManageChannels) {
          warnings.push(
            '⚠️ Ich konnte keinen Moderationschannel erstellen, da mir die Berechtigung **Kanäle verwalten** fehlt.',
          );
        } else {
          try {
            const created = await guild.channels.create({
              name: MODERATION_CHANNEL_NAME,
              type: ChannelType.GuildText,
              reason: 'Initial server setup via /init (Moderation)',
            });
            moderationChannel = created as SupportedGuildTextChannel;
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

      if (!moderationChannel && moderationHasChannel !== null && existingModerationChannelId) {
        try {
          const fallback = await guild.channels
            .fetch(existingModerationChannelId)
            .catch(() => null);
          if (isSupportedGuildTextChannel(fallback)) {
            updates.push(`ℹ️ Der bisher gespeicherte Moderationschannel (${fallback}) bleibt unverändert.`);
          }
        } catch (error) {
          console.warn('[init] Failed to keep previous moderation channel', error);
        }
      }
    } else if (moderationChoice === false) {
      if (existingModerationChannelId) {
        updates.push('ℹ️ Das Moderationsfeature bleibt deaktiviert, bestehende Einstellungen wurden nicht verändert.');
      } else {
        updates.push('ℹ️ Das Moderationsfeature wurde übersprungen.');
      }
    }

    if (updates.length === 0) {
      updates.push('ℹ️ Es wurden keine Änderungen vorgenommen.');
    }

    const response = [...updates, ...warnings].join('\n');
    await interaction.editReply(response);
  } catch (error) {
    console.error('[init] Failed to complete initialization', error);
    const message =
      '❌ Beim Initialisieren ist ein unerwarteter Fehler aufgetreten. Bitte versuche es erneut oder kontaktiere das Team.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction
        .reply({
          content: message,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  } finally {
    if (guildIdForInvalidation) {
      invalidateGuildInitializationCache(guildIdForInvalidation);
    }
  }
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
