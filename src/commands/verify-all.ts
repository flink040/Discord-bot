import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { getSupabaseClient } from '../supabase';
import type { CommandDef } from '../types/Command';

type UserRow = {
  discord_id: string | null;
  minecraft_username: string | null;
};

const VERIFIED_ROLE_NAME = 'verifiziert';

export const data = new SlashCommandBuilder()
  .setName('verify-all')
  .setDescription('Verifiziert alle Mitglieder anhand der Datenbank.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .setDMPermission(false);

function normalize(str: string) {
  return str.normalize('NFKC').toLowerCase();
}

async function updateNickname(member: GuildMember, nickname: string, allowNicknameChange: boolean): Promise<boolean> {
  if (!allowNicknameChange) return false;
  if (!member.manageable) return false;
  if (member.displayName === nickname) return false;
  try {
    await member.setNickname(nickname, 'verify-all sync');
    return true;
  } catch (err) {
    console.warn(`[verify-all] Failed to set nickname for ${member.id}:`, err);
    return false;
  }
}

async function ensureRole(member: GuildMember, roleId: string): Promise<boolean> {
  if (member.roles.cache.has(roleId)) return false;
  try {
    await member.roles.add(roleId, 'verify-all sync');
    return true;
  } catch (err) {
    console.warn(`[verify-all] Failed to add role for ${member.id}:`, err);
    return false;
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

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  const role = guild.roles.cache.find(r => normalize(r.name) === normalize(VERIFIED_ROLE_NAME));
  if (!role) {
    await interaction.editReply(`❌ Die Rolle "${VERIFIED_ROLE_NAME}" wurde nicht gefunden.`);
    return;
  }

  if (!role.editable) {
    await interaction.editReply('❌ Ich habe nicht genügend Rechte, um die Rolle "verifiziert" zu vergeben.');
    return;
  }

  const me = guild.members.me ?? (await guild.members.fetch(interaction.client.user.id));
  const canManageRoles = me.permissions.has(PermissionFlagsBits.ManageRoles);
  const canManageNicknames = me.permissions.has(PermissionFlagsBits.ManageNicknames);

  if (!canManageRoles) {
    await interaction.editReply('❌ Mir fehlt die Berechtigung **Rollen verwalten**, um diesen Befehl auszuführen.');
    return;
  }

  const supabase = getSupabaseClient();
  const { data: users, error } = await supabase
    .from('users')
    .select('discord_id, minecraft_username')
    .not('discord_id', 'is', null)
    .not('minecraft_username', 'is', null)
    .returns<UserRow[]>();

  if (error) {
    console.error('[verify-all] Failed to load users', error);
    await interaction.editReply('❌ Fehler beim Abrufen der Benutzerdaten.');
    return;
  }

  let matched = 0;
  let renamed = 0;
  let roleAssigned = 0;
  let notFound = 0;

  for (const row of users ?? []) {
    const discordId = row.discord_id;
    const nickname = row.minecraft_username;
    if (!discordId || !nickname) continue;

    let member = guild.members.cache.get(discordId);
    if (!member) {
      try {
        member = await guild.members.fetch({ user: discordId }).catch(() => undefined);
      } catch (err) {
        console.warn(`[verify-all] Failed to fetch member ${discordId}:`, err);
        member = undefined;
      }
    }
    if (!member) {
      notFound += 1;
      continue;
    }

    matched += 1;

    const didRename = await updateNickname(member, nickname, canManageNicknames);
    if (didRename) {
      renamed += 1;
    }

    const didAssignRole = await ensureRole(member, role.id);
    if (didAssignRole) {
      roleAssigned += 1;
    }
  }

  const summaryLines = [
    '✅ Verifizierung abgeschlossen.',
    `Gefundene Mitglieder: ${matched}`,
    `Nicknames aktualisiert: ${renamed}`,
    `Rollen vergeben: ${roleAssigned}`,
  ];

  if (notFound > 0) {
    summaryLines.push(`Nicht im Server gefunden: ${notFound}`);
  }

  if (!canManageNicknames) {
    summaryLines.push('Hinweis: Mir fehlt die Berechtigung **Spitznamen verwalten**.');
  }

  await interaction.editReply(summaryLines.join('\n'));
};

export default { data: data.toJSON(), execute } satisfies CommandDef;

