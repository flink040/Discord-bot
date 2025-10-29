import {
  DiscordAPIError,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { getSupabaseClient } from '../supabase';
import type { CommandDef } from '../types/Command';
import { fetchGuildMember, findVerifiedRole, VERIFIED_ROLE_NAME } from '../utils/verification';

const data = new SlashCommandBuilder()
  .setName('verify')
  .setDescription('Verknüpft deinen Minecraft-Account mit deinem Discord-Konto und vergibt dir die Verifizierungsrolle.')
  .addStringOption(option =>
    option
      .setName('minecraft-name')
      .setDescription('Dein Minecraft-Benutzername')
      .setRequired(true),
  );

type UserRow = {
  id?: string;
  discord_id: string | null;
  minecraft_username: string | null;
};

async function ensureRoleAssignment({
  interaction,
  member,
  roleId,
}: {
  interaction: ChatInputCommandInteraction;
  member: Exclude<Awaited<ReturnType<typeof fetchGuildMember>>, null>;
  roleId: string;
}): Promise<{ success: boolean; added: boolean }>
{
  if (member.roles.cache.has(roleId)) {
    return { success: true, added: false };
  }

  try {
    await member.roles.add(roleId, 'Self verification');
    return { success: true, added: true };
  } catch (err) {
    console.error('[verify] Failed to assign role', err);
    if (interaction.deferred || interaction.replied) {
      await interaction
        .editReply('❌ Ich konnte dir die Rolle "verifiziert" nicht zuweisen. Bitte wende dich an ein Teammitglied.')
        .catch(() => {});
    } else {
      await interaction
        .reply({
          content: '❌ Ich konnte dir die Rolle "verifiziert" nicht zuweisen. Bitte wende dich an ein Teammitglied.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
    return { success: false, added: false };
  }
}

function buildSuccessMessage({
  username,
  roleAdded,
  nicknameChanged,
  nicknameNotice,
}: {
  username: string;
  roleAdded: boolean;
  nicknameChanged: 'updated' | 'unchanged' | 'failed' | 'skipped';
  nicknameNotice: 'missing-permission' | 'unmanageable' | null;
}): string {
  const parts = [`✅ Du bist jetzt als **${username}** verifiziert.`];

  if (roleAdded) {
    parts.push(`Die Rolle "${VERIFIED_ROLE_NAME}" wurde dir zugewiesen.`);
  } else {
    parts.push('Die Rolle war bereits vorhanden.');
  }

  if (nicknameNotice === 'missing-permission') {
    parts.push('Hinweis: Ich habe nicht die Berechtigung, deinen Nicknamen zu ändern.');
  } else if (nicknameNotice === 'unmanageable') {
    parts.push('Hinweis: Ich kann deinen Nicknamen nicht ändern, da deine Rollen über mir stehen.');
  } else {
    switch (nicknameChanged) {
      case 'updated':
        parts.push('Dein Server-Spitzname wurde an deinen Minecraft-Namen angepasst.');
        break;
      case 'failed':
        parts.push('Hinweis: Beim Aktualisieren deines Spitznamens ist ein Fehler aufgetreten.');
        break;
      default:
        break;
    }
  }

  return parts.join('\n');
}

async function updateNicknameIfPossible({
  member,
  nickname,
  canManageNicknames,
}: {
  member: Exclude<Awaited<ReturnType<typeof fetchGuildMember>>, null>;
  nickname: string;
  canManageNicknames: boolean;
}): Promise<{ status: 'updated' | 'unchanged' | 'failed' | 'skipped'; notice: 'missing-permission' | 'unmanageable' | null }>
{
  if (!canManageNicknames) {
    return { status: 'skipped', notice: 'missing-permission' };
  }

  if (!member.manageable) {
    return { status: 'skipped', notice: 'unmanageable' };
  }

  if (member.nickname === nickname) {
    return { status: 'unchanged', notice: null };
  }

  try {
    await member.setNickname(nickname, 'Self verification');
    return { status: 'updated', notice: null };
  } catch (err) {
    if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.MissingPermissions) {
      return { status: 'skipped', notice: 'unmanageable' };
    }

    console.warn('[verify] Failed to set nickname:', err);
    return { status: 'failed', notice: null };
  }
}

export const execute = async (interaction: ChatInputCommandInteraction) => {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({
      content: 'Dieser Befehl kann nur in einem Server ausgeführt werden.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const usernameRaw = interaction.options.getString('minecraft-name', true).trim();
  if (!usernameRaw) {
    await interaction.reply({
      content: 'Bitte gib deinen Minecraft-Benutzernamen an.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  const member = await fetchGuildMember(guild, interaction.user.id);
  if (!member) {
    await interaction.editReply('❌ Ich konnte deine Mitgliedsdaten nicht abrufen. Bitte versuche es später erneut.');
    return;
  }

  const me = guild.members.me ?? (await guild.members.fetch(interaction.client.user.id));
  const canManageRoles = me.permissions.has(PermissionFlagsBits.ManageRoles);
  if (!canManageRoles) {
    await interaction.editReply('❌ Mir fehlt die Berechtigung **Rollen verwalten**, um dich zu verifizieren.');
    return;
  }

  const role = findVerifiedRole(guild);
  if (!role) {
    await interaction.editReply(`❌ Die Rolle "${VERIFIED_ROLE_NAME}" wurde nicht gefunden.`);
    return;
  }

  if (!role.editable) {
    await interaction.editReply('❌ Ich habe nicht genügend Rechte, um die Rolle "verifiziert" zu vergeben.');
    return;
  }

  const supabase = getSupabaseClient();

  const { data: rows, error } = await supabase
    .from('users')
    .select('id, discord_id, minecraft_username')
    .ilike('minecraft_username', usernameRaw)
    .limit(1);

  if (error) {
    console.error('[verify] Failed to load user from Supabase', error);
    await interaction.editReply('❌ Fehler beim Abrufen deiner Daten. Bitte versuche es später erneut.');
    return;
  }

  const row: UserRow | undefined = rows?.[0];
  if (!row || !row.minecraft_username) {
    await interaction.editReply('❌ Es wurde kein Eintrag mit diesem Minecraft-Namen gefunden. Bitte überprüfe die Schreibweise.');
    return;
  }

  const username = row.minecraft_username;

  if (row.discord_id && row.discord_id !== interaction.user.id) {
    await interaction.editReply('❌ Dieser Minecraft-Name ist bereits mit einem anderen Discord-Account verknüpft.');
    return;
  }

  if (!row.discord_id) {
    const matchUsername = username;
    const updateQuery = supabase.from('users').update({ discord_id: interaction.user.id });
    const { error: updateError } = matchUsername
      ? await updateQuery.eq('minecraft_username', matchUsername)
      : await updateQuery.ilike('minecraft_username', usernameRaw);

    if (updateError) {
      console.error('[verify] Failed to update user in Supabase', updateError);
      await interaction.editReply('❌ Fehler beim Speichern deiner Verifizierung. Bitte versuche es später erneut.');
      return;
    }
  }

  const canManageNicknames = me.permissions.has(PermissionFlagsBits.ManageNicknames);
  const nicknameResult = await updateNicknameIfPossible({
    member,
    nickname: username,
    canManageNicknames,
  });

  const roleAssigned = await ensureRoleAssignment({ interaction, member, roleId: role.id });
  if (!roleAssigned.success) {
    return;
  }

  const message = buildSuccessMessage({
    username,
    roleAdded: roleAssigned.added,
    nicknameChanged: nicknameResult.status,
    nicknameNotice: nicknameResult.notice,
  });

  await interaction.editReply(message);
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
