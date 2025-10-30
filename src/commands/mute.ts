import {
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { CommandDef } from '../types/Command';
import { getModerationChannelId } from '../utils/moderation';

const MAX_TIMEOUT_MINUTES = 28 * 24 * 60; // Discord allows up to 28 days

function assertGuildMember(member: GuildMember | null): asserts member is GuildMember {
  if (!member) {
    throw new Error('Member not found in guild.');
  }
}

export const data = new SlashCommandBuilder()
  .setName('mute')
  .setDescription('Mute einen Spieler für eine bestimmte Dauer.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(option =>
    option
      .setName('spieler')
      .setDescription('Der Spieler, der gemuted werden soll.')
      .setRequired(true),
  )
  .addIntegerOption(option =>
    option
      .setName('minuten')
      .setDescription('Dauer des Mutes in Minuten (max. 28 Tage).')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(MAX_TIMEOUT_MINUTES),
  )
  .addStringOption(option =>
    option
      .setName('grund')
      .setDescription('Grund für den Mute.')
      .setRequired(true)
      .setMaxLength(512),
  );

type MuteCommandInteraction = ChatInputCommandInteraction<'cached'>;

async function ensureGuildInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<MuteCommandInteraction> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: '❌ Dieser Befehl kann nur innerhalb eines Servers verwendet werden.',
      flags: MessageFlags.Ephemeral,
    });
    throw new Error('Mute command invoked outside of guild.');
  }
  return interaction;
}

async function requireModeratorPermission(interaction: MuteCommandInteraction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({
      content: '❌ Du benötigst die Berechtigung "Mitglieder moderieren", um diesen Befehl zu nutzen.',
      flags: MessageFlags.Ephemeral,
    });
    throw new Error('Missing permission: ModerateMembers');
  }
}

function formatInlineCode(value: string): string {
  return `\`${value.replace(/`/g, '\\`').replace(/\r?\n|\r/g, ' ')}\``;
}

async function notifyModerationChannel(interaction: MuteCommandInteraction, message: string) {
  const channelId =
    (await getModerationChannelId(interaction.guild.id)) ?? process.env.MODERATION_CHANNEL_ID;
  if (!channelId) {
    return;
  }

  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn('[mute] Konfigurierter Moderationschannel nicht gefunden oder nicht textbasiert.');
    return;
  }

  await channel.send({ content: message }).catch((err) => {
    console.error('[mute] Fehler beim Senden der Moderationsnachricht:', err);
  });
}

export const execute = async (rawInteraction: ChatInputCommandInteraction) => {
  const interaction = await ensureGuildInteraction(rawInteraction);
  await requireModeratorPermission(interaction);

  const targetUser = interaction.options.getUser('spieler', true);
  const minutes = interaction.options.getInteger('minuten', true);
  const reason = interaction.options.getString('grund', true).trim();

  if (targetUser.id === interaction.user.id) {
    await interaction.reply({
      content: '❌ Du kannst dich nicht selbst muten.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guild = interaction.guild;

  const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
  assertGuildMember(targetMember);

  if (!targetMember.moderatable) {
    await interaction.reply({
      content: '❌ Ich kann diesen Nutzer nicht muten (fehlende Berechtigungen oder höhere Rolle).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const durationMs = minutes * 60 * 1000;
  const auditReason = `${reason} — Ausgeführt von ${interaction.user.tag}`.slice(0, 512);

  try {
    await targetMember.timeout(durationMs, auditReason);
  } catch (error) {
    console.error('[mute] Fehler beim Timeout:', error);
    await interaction.reply({
      content: '❌ Der Nutzer konnte nicht gemutet werden. Bitte prüfe die Bot-Berechtigungen.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const confirmation = `✅ ${targetMember.user.tag} wurde für ${minutes} Minuten gemuted.`;
  await interaction.reply({
    content: confirmation,
    flags: MessageFlags.Ephemeral,
  });

  const logMessage =
    `${interaction.user.tag} hat ${formatInlineCode(targetMember.user.tag)} ` +
    `(${formatInlineCode(targetMember.id)}) für ${formatInlineCode(String(minutes))} Minuten ` +
    `gemuted - ${formatInlineCode(reason)}`;
  await notifyModerationChannel(interaction, logMessage);
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
