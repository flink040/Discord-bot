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

const MODERATION_CHANNEL_NAME = 'moderation-log';
const MARKETPLACE_CHANNEL_NAME = 'marktplatz';
const RENAME_PERMISSION_FLAGS = [
  PermissionFlagsBits.ChangeNickname,
  PermissionFlagsBits.ManageNicknames,
] as const;

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

  try {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply('❌ Der Server konnte nicht geladen werden. Bitte versuche es erneut.');
      return;
    }

    const me = guild.members.me ?? (await guild.members.fetch(interaction.client.user.id));
    const requestedMarketplaceInterval = interaction.options.getInteger('marktplatz_intervall');
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
  let marketplacePostIntervalHours = await getMarketplacePostIntervalHours(guild.id);
  let marketplaceChannel: GuildBasedChannel | null = null;

  if (existingMarketplaceChannelId) {
    try {
      const fetched = await guild.channels.fetch(existingMarketplaceChannelId);
      if (isSupportedGuildTextChannel(fetched)) {
        marketplaceChannel = fetched;
        const intervalInfo =
          marketplacePostIntervalHours !== null
            ? ` Der aktuelle Post-Intervall beträgt ${marketplacePostIntervalHours} Stunden.`
            : '';
        updates.push(`ℹ️ Marktplatz-Einträge werden bereits in ${fetched} veröffentlicht.${intervalInfo}`);
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

  let shouldCreateMarketplaceChannel = false;

  if (!marketplaceChannel) {
    const channelSelectRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('init-marketplace-select')
        .setPlaceholder('Wähle einen Channel für den Marktplatz')
        .setMinValues(1)
        .setMaxValues(1)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    );

    const filter = (componentInteraction: MessageComponentInteraction) =>
      componentInteraction.user.id === interaction.user.id;

    if (canManageChannels) {
      const promptMessage = await interaction.followUp({
        content: 'Soll ich einen neuen Marktplatzchannel erstellen?',
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId('init-marketplace-create')
              .setLabel('Ja, bitte erstellen')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId('init-marketplace-use-existing')
              .setLabel('Nein, bestehenden wählen')
              .setStyle(ButtonStyle.Secondary),
          ),
        ],
        ephemeral: true,
      });

      try {
        const choice = (await promptMessage.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter,
          time: 60_000,
        })) as ButtonInteraction;

        if (choice.customId === 'init-marketplace-create') {
          shouldCreateMarketplaceChannel = true;
          await choice.update({ content: 'Alles klar, ich erstelle einen neuen Marktplatzchannel …', components: [] });
        } else {
          await choice.update({
            content: 'Bitte wähle einen bestehenden Channel für den Marktplatz aus.',
            components: [channelSelectRow],
          });

          try {
            const selection = (await promptMessage.awaitMessageComponent({
              componentType: ComponentType.ChannelSelect,
              filter,
              time: 60_000,
            })) as ChannelSelectMenuInteraction;

            const selectedChannelId = selection.values[0];
            const selectedChannel =
              guild.channels.cache.get(selectedChannelId) ??
              (await guild.channels.fetch(selectedChannelId));

            if (isSupportedGuildTextChannel(selectedChannel)) {
              marketplaceChannel = selectedChannel;
              const stored = await setMarketplaceChannelId(guild.id, selectedChannel.id, guild.name);

              if (stored) {
                updates.push(`✅ Marktplatz-Einträge werden nun in ${selectedChannel} veröffentlicht.`);
              } else {
                warnings.push('⚠️ Der ausgewählte Marktplatzchannel konnte nicht gespeichert werden.');
              }

              await selection.update({
                content: marketplaceChannel
                  ? `✅ ${marketplaceChannel} wird als Marktplatzchannel verwendet.`
                  : '✅ Channel gespeichert.',
                components: [],
              });
            } else {
              await selection.update({
                content:
                  '⚠️ Der ausgewählte Channel ist kein Textchannel. Bitte führe /init erneut aus, um einen gültigen Channel zu wählen.',
                components: [],
              });
              warnings.push('⚠️ Es wurde kein gültiger Marktplatzchannel ausgewählt.');
            }
          } catch (selectionError) {
            console.warn('[init] No marketplace channel selected', selectionError);
            await promptMessage.edit({
              content:
                '⚠️ Es wurde kein Channel ausgewählt. Du kannst /init erneut ausführen, um einen Marktplatzchannel festzulegen.',
              components: [],
            });
            warnings.push(
              '⚠️ Es wurde kein Channel ausgewählt. Du kannst /init erneut ausführen, um einen Marktplatzchannel festzulegen.',
            );
          }
        }
      } catch (choiceError) {
        console.warn('[init] No choice made for marketplace channel', choiceError);
        await promptMessage.edit({
          content:
            '⚠️ Es wurde keine Auswahl getroffen. Du kannst /init erneut ausführen, um einen Marktplatzchannel festzulegen.',
          components: [],
        });
        warnings.push(
          '⚠️ Es wurde keine Auswahl getroffen. Du kannst /init erneut ausführen, um einen Marktplatzchannel festzulegen.',
        );
      }
    } else {
      const promptMessage = await interaction.followUp({
        content:
          'Ich kann keinen neuen Marktplatzchannel erstellen, da mir die Berechtigung **Kanäle verwalten** fehlt. Bitte wähle einen bestehenden Channel.',
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
          guild.channels.cache.get(selectedChannelId) ?? (await guild.channels.fetch(selectedChannelId));

        if (isSupportedGuildTextChannel(selectedChannel)) {
          marketplaceChannel = selectedChannel;
          const stored = await setMarketplaceChannelId(guild.id, selectedChannel.id, guild.name);

          if (stored) {
            updates.push(`✅ Marktplatz-Einträge werden nun in ${selectedChannel} veröffentlicht.`);
          } else {
            warnings.push('⚠️ Der ausgewählte Marktplatzchannel konnte nicht gespeichert werden.');
          }

          await selection.update({
            content: marketplaceChannel
              ? `✅ ${marketplaceChannel} wird als Marktplatzchannel verwendet.`
              : '✅ Channel gespeichert.',
            components: [],
          });
        } else {
          await selection.update({
            content:
              '⚠️ Der ausgewählte Channel ist kein Textchannel. Bitte führe /init erneut aus, um einen gültigen Channel zu wählen.',
            components: [],
          });
          warnings.push('⚠️ Es wurde kein gültiger Marktplatzchannel ausgewählt.');
        }
      } catch (selectionError) {
        console.warn('[init] No marketplace channel selected (no permissions)', selectionError);
        await promptMessage.edit({
          content:
            '⚠️ Es wurde kein Channel ausgewählt. Bitte führe /init erneut aus oder erteile mir die benötigten Berechtigungen.',
          components: [],
        });
        warnings.push(
          '⚠️ Es wurde kein Channel ausgewählt. Bitte führe /init erneut aus oder erteile mir die benötigten Berechtigungen.',
        );
      }
    }
  }

  if (!marketplaceChannel && shouldCreateMarketplaceChannel) {
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
  } else if (!marketplaceChannel && !shouldCreateMarketplaceChannel) {
    warnings.push(
      '⚠️ Es wurde kein Marktplatzchannel eingerichtet. Du kannst /init erneut ausführen, um dies nachzuholen.',
    );
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
          updates.push(
            `✅ Der Marktplatz-Post-Intervall wurde auf ${intervalToPersist} Stunden festgelegt.`,
          );
        } else if (intervalToPersist === DEFAULT_MARKETPLACE_POST_INTERVAL_HOURS) {
          updates.push(
            `✅ Der Marktplatz-Post-Intervall wurde auf den Standardwert von ${intervalToPersist} Stunden gesetzt.`,
          );
        } else {
          updates.push(
            `✅ Der Marktplatz-Post-Intervall wurde auf ${intervalToPersist} Stunden aktualisiert.`,
          );
        }
      } else {
        warnings.push('⚠️ Der Marktplatz-Post-Intervall konnte nicht gespeichert werden.');
      }
    } else if (marketplacePostIntervalHours !== null) {
      updates.push(
        `ℹ️ Der Marktplatz-Post-Intervall bleibt bei ${marketplacePostIntervalHours} Stunden.`,
      );
    }
  } else if (requestedMarketplaceInterval !== null) {
    warnings.push(
      '⚠️ Es konnte kein Marktplatzchannel eingerichtet werden, daher wurde kein Post-Intervall gespeichert.',
    );
  }

    if (updates.length === 0) {
      updates.push('ℹ️ Es waren keine Änderungen erforderlich.');
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
  }
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
